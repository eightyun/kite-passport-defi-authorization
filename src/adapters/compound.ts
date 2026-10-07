import { decodeFunctionData, getAddress, parseAbi } from 'viem';
import { BASE_USDC } from '../contracts.js';
import { transactionFingerprint } from '../permit2.js';
import type {
    Address,
    Amount,
    BalanceChange,
    CompoundAction,
    CompoundExposure,
    Hex,
    IntentAnalysis,
    TransactionEnvelope,
    UnknownAction
} from '../domain.js';

export const compoundCometAbi = parseAbi([
    'function supply(address asset,uint256 amount)',
    'function supplyTo(address dst,address asset,uint256 amount)',
    'function supplyFrom(address from,address dst,address asset,uint256 amount)',
    'function withdraw(address asset,uint256 amount)',
    'function withdrawTo(address to,address asset,uint256 amount)',
    'function withdrawFrom(address src,address to,address asset,uint256 amount)',
    'function allow(address manager,bool isAllowed)',
    'function allowBySig(address owner,address manager,bool isAllowed,uint256 nonce,uint256 expiry,uint8 v,bytes32 r,bytes32 s)'
]);

const MAX_UINT256 = (1n << 256n) - 1n;

function address(value: Address): Address {
    return getAddress(value) as Address;
}

function amount(value: bigint): Amount {
    return value === MAX_UINT256 ? { value: 'all', mode: 'all' } : { value: value.toString(), mode: 'exact' };
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
        protocol: 'compound',
        adapter: 'compound-v3-base-usdc',
        chainId: transaction.chainId,
        sender: transaction.from,
        target: transaction.to,
        nativeValue: transaction.value,
        transactionFingerprint: transactionFingerprint(transaction),
        actions: [action],
        expectedBalanceChanges: [],
        warnings: ['Unsupported or malformed Compound III calls are rejected.'],
        ...(transaction.source ? { source: transaction.source } : {})
    };
}

function signature(v: number, r: Hex, s: Hex): Hex {
    return `${r}${s.slice(2)}${v.toString(16).padStart(2, '0')}` as Hex;
}

function exactDelta(before: string, after: string): Amount {
    const delta = BigInt(after) - BigInt(before);
    return { value: (delta < 0n ? -delta : delta).toString(), mode: 'exact' };
}

export function compoundBalanceChanges(action: CompoundAction, exposure?: CompoundExposure): readonly BalanceChange[] {
    if (!action.asset || !action.amount) return [];
    const amountValue = exposure?.amount ?? action.amount.value;
    const resolvedAmount: Amount = exposure ? { value: amountValue, mode: 'exact' } : action.amount;
    if (action.operation === 'supply-collateral') {
        return [
            {
                account: action.source,
                asset: action.asset,
                category: 'asset',
                direction: 'debit',
                amount: resolvedAmount,
                reason: 'Compound III collateral supply transfers the asset into Comet'
            }
        ];
    }
    if (action.operation === 'withdraw-collateral') {
        return [
            {
                account: action.recipient ?? action.account,
                asset: action.asset,
                category: 'asset',
                direction: 'credit',
                amount: resolvedAmount,
                reason: 'Compound III collateral withdrawal transfers the asset to the recipient'
            }
        ];
    }
    if (
        action.operation === 'supply-base' ||
        action.operation === 'repay-base' ||
        action.operation === 'repay-and-supply-base'
    ) {
        return [
            {
                account: action.source,
                asset: action.asset,
                category: 'asset',
                direction: 'debit',
                amount: resolvedAmount,
                reason: 'Compound III base supply transfers the base asset into Comet'
            },
            ...(exposure && BigInt(exposure.baseBorrowBefore) > BigInt(exposure.baseBorrowAfter)
                ? [
                      {
                          account: action.account,
                          asset: action.asset,
                          category: 'debt' as const,
                          direction: 'debit' as const,
                          amount: exactDelta(exposure.baseBorrowBefore, exposure.baseBorrowAfter),
                          reason: 'Compound III base supply repays outstanding base debt'
                      }
                  ]
                : []),
            ...(exposure && BigInt(exposure.baseSupplyAfter) > BigInt(exposure.baseSupplyBefore)
                ? [
                      {
                          account: action.account,
                          asset: action.market,
                          category: 'receipt' as const,
                          direction: 'credit' as const,
                          amount: exactDelta(exposure.baseSupplyBefore, exposure.baseSupplyAfter),
                          reason: 'Compound III base supply increases the interest-bearing Comet balance'
                      }
                  ]
                : [])
        ];
    }
    return [
        ...(exposure && BigInt(exposure.baseSupplyBefore) > BigInt(exposure.baseSupplyAfter)
            ? [
                  {
                      account: action.account,
                      asset: action.market,
                      category: 'receipt' as const,
                      direction: 'debit' as const,
                      amount: exactDelta(exposure.baseSupplyBefore, exposure.baseSupplyAfter),
                      reason: 'Compound III base withdrawal reduces the interest-bearing Comet balance'
                  }
              ]
            : []),
        ...(exposure && BigInt(exposure.baseBorrowAfter) > BigInt(exposure.baseBorrowBefore)
            ? [
                  {
                      account: action.account,
                      asset: action.asset,
                      category: 'debt' as const,
                      direction: 'credit' as const,
                      amount: exactDelta(exposure.baseBorrowBefore, exposure.baseBorrowAfter),
                      reason: 'Compound III base withdrawal increases base debt'
                  }
              ]
            : []),
        {
            account: action.recipient ?? action.account,
            asset: action.asset,
            category: 'asset',
            direction: 'credit',
            amount: resolvedAmount,
            reason: 'Compound III base withdrawal transfers the base asset to the recipient'
        }
    ];
}

export function decodeCompoundTransaction(transaction: TransactionEnvelope): IntentAnalysis {
    try {
        if (transaction.value !== '0')
            return unknown(transaction, 'Compound III Comet calls do not accept native value.');
        const decoded = decodeFunctionData({ abi: compoundCometAbi, data: transaction.data });
        let action: CompoundAction;
        if (decoded.functionName === 'supply') {
            const asset = address(decoded.args[0]);
            action = {
                kind: 'compound',
                index: 0,
                operation: asset.toLowerCase() === BASE_USDC.toLowerCase() ? 'supply-base' : 'supply-collateral',
                method: 'supply',
                market: transaction.to,
                asset,
                amount: amount(decoded.args[1]),
                operator: transaction.from,
                source: transaction.from,
                account: transaction.from
            };
        } else if (decoded.functionName === 'supplyTo') {
            const asset = address(decoded.args[1]);
            action = {
                kind: 'compound',
                index: 0,
                operation: asset.toLowerCase() === BASE_USDC.toLowerCase() ? 'supply-base' : 'supply-collateral',
                method: 'supplyTo',
                market: transaction.to,
                asset,
                amount: amount(decoded.args[2]),
                operator: transaction.from,
                source: transaction.from,
                account: address(decoded.args[0])
            };
        } else if (decoded.functionName === 'supplyFrom') {
            const asset = address(decoded.args[2]);
            action = {
                kind: 'compound',
                index: 0,
                operation: asset.toLowerCase() === BASE_USDC.toLowerCase() ? 'supply-base' : 'supply-collateral',
                method: 'supplyFrom',
                market: transaction.to,
                asset,
                amount: amount(decoded.args[3]),
                operator: transaction.from,
                source: address(decoded.args[0]),
                account: address(decoded.args[1])
            };
        } else if (decoded.functionName === 'withdraw') {
            const asset = address(decoded.args[0]);
            action = {
                kind: 'compound',
                index: 0,
                operation: asset.toLowerCase() === BASE_USDC.toLowerCase() ? 'withdraw-base' : 'withdraw-collateral',
                method: 'withdraw',
                market: transaction.to,
                asset,
                amount: amount(decoded.args[1]),
                operator: transaction.from,
                source: transaction.from,
                account: transaction.from,
                recipient: transaction.from
            };
        } else if (decoded.functionName === 'withdrawTo') {
            const asset = address(decoded.args[1]);
            action = {
                kind: 'compound',
                index: 0,
                operation: asset.toLowerCase() === BASE_USDC.toLowerCase() ? 'withdraw-base' : 'withdraw-collateral',
                method: 'withdrawTo',
                market: transaction.to,
                asset,
                amount: amount(decoded.args[2]),
                operator: transaction.from,
                source: transaction.from,
                account: transaction.from,
                recipient: address(decoded.args[0])
            };
        } else if (decoded.functionName === 'withdrawFrom') {
            const asset = address(decoded.args[2]);
            action = {
                kind: 'compound',
                index: 0,
                operation: asset.toLowerCase() === BASE_USDC.toLowerCase() ? 'withdraw-base' : 'withdraw-collateral',
                method: 'withdrawFrom',
                market: transaction.to,
                asset,
                amount: amount(decoded.args[3]),
                operator: transaction.from,
                source: address(decoded.args[0]),
                account: address(decoded.args[0]),
                recipient: address(decoded.args[1])
            };
        } else if (decoded.functionName === 'allow') {
            action = {
                kind: 'compound',
                index: 0,
                operation: decoded.args[1] ? 'allow-manager' : 'disallow-manager',
                method: 'allow',
                market: transaction.to,
                operator: transaction.from,
                source: transaction.from,
                account: transaction.from,
                manager: address(decoded.args[0]),
                isAllowed: decoded.args[1]
            };
        } else {
            action = {
                kind: 'compound',
                index: 0,
                operation: decoded.args[2] ? 'allow-manager' : 'disallow-manager',
                method: 'allowBySig',
                market: transaction.to,
                operator: transaction.from,
                source: address(decoded.args[0]),
                account: address(decoded.args[0]),
                manager: address(decoded.args[1]),
                isAllowed: decoded.args[2],
                nonce: decoded.args[3].toString(),
                expiry: decoded.args[4].toString(),
                signature: signature(decoded.args[5], decoded.args[6], decoded.args[7])
            };
        }
        return {
            schemaVersion: '1.0',
            protocol: 'compound',
            adapter: 'compound-v3-base-usdc',
            chainId: transaction.chainId,
            sender: transaction.from,
            target: transaction.to,
            nativeValue: transaction.value,
            transactionFingerprint: transactionFingerprint(transaction),
            actions: [action],
            expectedBalanceChanges: compoundBalanceChanges(action),
            warnings: [
                'Compound III authorization requires fixed-block market, account, permission and simulation evidence.'
            ],
            ...(transaction.source ? { source: transaction.source } : {})
        };
    } catch {
        return unknown(transaction, `Unsupported Compound III selector ${transaction.data.slice(0, 10)}`);
    }
}
