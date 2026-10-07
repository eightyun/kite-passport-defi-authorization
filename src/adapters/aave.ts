import { decodeFunctionData, getAddress, parseAbi } from 'viem';
import { transactionFingerprint } from '../permit2.js';
import type {
    AaveAction,
    AaveExposure,
    Address,
    Amount,
    BalanceChange,
    IntentAnalysis,
    TransactionEnvelope,
    UnknownAction
} from '../domain.js';

export const aavePoolAbi = parseAbi([
    'function supply(address asset,uint256 amount,address onBehalfOf,uint16 referralCode)',
    'function withdraw(address asset,uint256 amount,address to) returns (uint256)',
    'function borrow(address asset,uint256 amount,uint256 interestRateMode,uint16 referralCode,address onBehalfOf)',
    'function repay(address asset,uint256 amount,uint256 interestRateMode,address onBehalfOf) returns (uint256)',
    'function setUserUseReserveAsCollateral(address asset,bool useAsCollateral)'
]);

const MAX_UINT256 = (1n << 256n) - 1n;

function address(value: Address): Address {
    return getAddress(value) as Address;
}

function amount(value: bigint, supportsAll: boolean): Amount {
    return supportsAll && value === MAX_UINT256
        ? { value: 'all', mode: 'all' }
        : { value: value.toString(), mode: 'exact' };
}

function unknown(transaction: TransactionEnvelope, reason: string): IntentAnalysis {
    const selector = transaction.data.slice(0, 10);
    const action: UnknownAction = {
        kind: 'unknown',
        index: 0,
        code: Number.parseInt(selector.slice(2), 16),
        reason
    };
    return {
        schemaVersion: '1.0',
        protocol: 'aave',
        adapter: 'aave-v3-base',
        chainId: transaction.chainId,
        sender: transaction.from,
        target: transaction.to,
        nativeValue: transaction.value,
        transactionFingerprint: transactionFingerprint(transaction),
        actions: [action],
        expectedBalanceChanges: [],
        warnings: ['Unsupported or malformed Aave calls are rejected.'],
        ...(transaction.source ? { source: transaction.source } : {})
    };
}

function exactDelta(before: string, after: string): Amount {
    const delta = BigInt(after) - BigInt(before);
    return { value: (delta < 0n ? -delta : delta).toString(), mode: 'exact' };
}

export function aaveBalanceChanges(action: AaveAction, exposure?: AaveExposure): readonly BalanceChange[] {
    if (!action.amount) return [];
    if (action.operation === 'supply') {
        return [
            {
                account: 'sender',
                asset: action.asset,
                category: 'asset',
                direction: 'debit',
                amount: action.amount,
                reason: 'Aave supply transfers the underlying asset to the Pool'
            },
            ...(action.receiptToken
                ? [
                      {
                          account: action.beneficiary,
                          asset: action.receiptToken,
                          category: 'receipt' as const,
                          direction: 'credit' as const,
                          amount: exposure
                              ? exactDelta(exposure.aTokenBalanceBefore, exposure.aTokenBalanceAfter)
                              : { value: action.amount.value, mode: 'maximum' as const },
                          reason: 'Aave supply mints aTokens after liquidity-index floor rounding'
                      }
                  ]
                : [])
        ];
    }
    if (action.operation === 'withdraw') {
        return [
            ...(action.receiptToken
                ? [
                      {
                          account: action.beneficiary,
                          asset: action.receiptToken,
                          category: 'receipt' as const,
                          direction: 'debit' as const,
                          amount: exposure
                              ? exactDelta(exposure.aTokenBalanceBefore, exposure.aTokenBalanceAfter)
                              : { value: action.amount.value, mode: 'minimum' as const },
                          reason: 'Aave withdrawal burns aTokens after liquidity-index ceiling rounding'
                      }
                  ]
                : []),
            {
                account: action.recipient ?? action.beneficiary,
                asset: action.asset,
                category: 'asset',
                direction: 'credit',
                amount: action.amount,
                reason: 'Aave withdrawal transfers underlying to the recipient'
            }
        ];
    }
    if (action.operation === 'borrow') {
        return [
            {
                account: action.recipient ?? 'sender',
                asset: action.asset,
                category: 'asset',
                direction: 'credit',
                amount: action.amount,
                reason: 'Aave borrow transfers underlying to the caller'
            },
            {
                account: action.beneficiary,
                asset: action.variableDebtToken ?? action.asset,
                category: 'debt',
                direction: 'credit',
                amount: exposure
                    ? exactDelta(exposure.variableDebtBefore, exposure.variableDebtAfter)
                    : { value: action.amount.value, mode: 'minimum' },
                reason: 'Aave variable debt increases after borrow-index ceiling rounding'
            }
        ];
    }
    if (action.operation === 'repay') {
        return [
            {
                account: 'sender',
                asset: action.asset,
                category: 'asset',
                direction: 'debit',
                amount: action.amount,
                reason: 'Aave repayment transfers underlying to the Pool'
            },
            {
                account: action.beneficiary,
                asset: action.variableDebtToken ?? action.asset,
                category: 'debt',
                direction: 'debit',
                amount: exposure
                    ? exactDelta(exposure.variableDebtBefore, exposure.variableDebtAfter)
                    : { value: action.amount.value, mode: 'maximum' },
                reason: 'Aave variable debt decreases after borrow-index floor rounding'
            }
        ];
    }
    return [];
}

export function decodeAaveTransaction(transaction: TransactionEnvelope): IntentAnalysis {
    try {
        if (transaction.value !== '0') return unknown(transaction, 'Aave Pool operations do not accept native value.');
        const decoded = decodeFunctionData({ abi: aavePoolAbi, data: transaction.data });
        const asset = address(decoded.args[0] as Address);
        let action: AaveAction;
        if (decoded.functionName === 'supply') {
            action = {
                kind: 'aave',
                index: 0,
                operation: 'supply',
                asset,
                amount: amount(decoded.args[1], false),
                beneficiary: address(decoded.args[2]),
                referralCode: decoded.args[3]
            };
        } else if (decoded.functionName === 'withdraw') {
            action = {
                kind: 'aave',
                index: 0,
                operation: 'withdraw',
                asset,
                amount: amount(decoded.args[1], true),
                beneficiary: address(transaction.from),
                recipient: address(decoded.args[2])
            };
        } else if (decoded.functionName === 'borrow') {
            action = {
                kind: 'aave',
                index: 0,
                operation: 'borrow',
                asset,
                amount: amount(decoded.args[1], false),
                beneficiary: address(decoded.args[4]),
                recipient: address(transaction.from),
                interestRateMode: Number(decoded.args[2]),
                referralCode: decoded.args[3]
            };
        } else if (decoded.functionName === 'repay') {
            action = {
                kind: 'aave',
                index: 0,
                operation: 'repay',
                asset,
                amount: amount(decoded.args[1], true),
                beneficiary: address(decoded.args[3]),
                interestRateMode: Number(decoded.args[2])
            };
        } else {
            const enabled = decoded.args[1];
            action = {
                kind: 'aave',
                index: 0,
                operation: enabled ? 'enable-collateral' : 'disable-collateral',
                asset,
                beneficiary: address(transaction.from)
            };
        }
        return {
            schemaVersion: '1.0',
            protocol: 'aave',
            adapter: 'aave-v3-base',
            chainId: transaction.chainId,
            sender: transaction.from,
            target: transaction.to,
            nativeValue: transaction.value,
            transactionFingerprint: transactionFingerprint(transaction),
            actions: [action],
            expectedBalanceChanges: aaveBalanceChanges(action),
            warnings: ['Aave authorization requires fixed-block reserve, account and simulation evidence.'],
            ...(transaction.source ? { source: transaction.source } : {})
        };
    } catch {
        return unknown(transaction, `Unsupported Aave selector ${transaction.data.slice(0, 10)}`);
    }
}
