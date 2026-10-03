import { decodeFunctionData, encodeAbiParameters, getAddress, keccak256, parseAbi, parseAbiParameters } from 'viem';
import { transactionFingerprint } from '../permit2.js';
import type {
    Address,
    Amount,
    BalanceChange,
    Hex,
    IntentAnalysis,
    MorphoAction,
    MorphoMarketParams,
    TransactionEnvelope,
    UnknownAction
} from '../domain.js';

export const morphoAbi = parseAbi([
    'function supply((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) marketParams,uint256 assets,uint256 shares,address onBehalf,bytes data) returns (uint256 assetsSupplied,uint256 sharesSupplied)',
    'function withdraw((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) marketParams,uint256 assets,uint256 shares,address onBehalf,address receiver) returns (uint256 assetsWithdrawn,uint256 sharesWithdrawn)',
    'function borrow((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) marketParams,uint256 assets,uint256 shares,address onBehalf,address receiver) returns (uint256 assetsBorrowed,uint256 sharesBorrowed)',
    'function repay((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) marketParams,uint256 assets,uint256 shares,address onBehalf,bytes data) returns (uint256 assetsRepaid,uint256 sharesRepaid)',
    'function supplyCollateral((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) marketParams,uint256 assets,address onBehalf,bytes data)',
    'function withdrawCollateral((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) marketParams,uint256 assets,address onBehalf,address receiver)'
]);

function address(value: Address): Address {
    return getAddress(value) as Address;
}

export function morphoMarketId(params: MorphoMarketParams): Hex {
    return keccak256(
        encodeAbiParameters(parseAbiParameters('address,address,address,address,uint256'), [
            params.loanToken,
            params.collateralToken,
            params.oracle,
            params.irm,
            BigInt(params.lltv)
        ])
    );
}

function amount(assets: bigint, shares?: bigint): Amount {
    if (assets !== 0n) return { value: assets.toString(), mode: 'exact' };
    if (shares !== undefined && shares !== 0n) return { value: 'unknown', mode: 'unknown' };
    return { value: '0', mode: 'exact' };
}

export function morphoBalanceChanges(action: MorphoAction): readonly BalanceChange[] {
    const asset = action.operation.includes('collateral')
        ? action.marketParams.collateralToken
        : action.marketParams.loanToken;
    const account = action.receiver ?? action.beneficiary;
    const direction =
        action.operation === 'supply' || action.operation === 'repay' || action.operation === 'supply-collateral'
            ? 'debit'
            : 'credit';
    const changes: BalanceChange[] = [
        {
            account: direction === 'debit' ? 'sender' : account,
            asset,
            category: 'asset',
            direction,
            amount: action.assets,
            reason: `Morpho ${action.operation} asset transfer`
        }
    ];
    if (action.operation === 'borrow' || action.operation === 'repay') {
        changes.push({
            account: action.beneficiary,
            asset: action.marketParams.loanToken,
            category: 'debt',
            direction: action.operation === 'borrow' ? 'credit' : 'debit',
            amount: action.assets,
            reason: `Morpho ${action.operation} debt change`
        });
    }
    return changes;
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
        protocol: 'morpho',
        adapter: 'morpho-blue-v1',
        chainId: transaction.chainId,
        sender: transaction.from,
        target: transaction.to,
        nativeValue: transaction.value,
        transactionFingerprint: transactionFingerprint(transaction),
        actions: [action],
        expectedBalanceChanges: [],
        warnings: ['Unsupported or malformed Morpho calls are rejected.'],
        ...(transaction.source ? { source: transaction.source } : {})
    };
}

export function decodeMorphoTransaction(transaction: TransactionEnvelope): IntentAnalysis {
    try {
        const decoded = decodeFunctionData({ abi: morphoAbi, data: transaction.data });
        const rawParams = decoded.args[0];
        const params: MorphoMarketParams = {
            loanToken: address(rawParams.loanToken),
            collateralToken: address(rawParams.collateralToken),
            oracle: address(rawParams.oracle),
            irm: address(rawParams.irm),
            lltv: rawParams.lltv.toString()
        };
        const operation =
            decoded.functionName === 'supplyCollateral'
                ? 'supply-collateral'
                : decoded.functionName === 'withdrawCollateral'
                  ? 'withdraw-collateral'
                  : decoded.functionName;
        const collateralOperation = operation === 'supply-collateral' || operation === 'withdraw-collateral';
        const assets = decoded.args[1] as bigint;
        const shares = collateralOperation ? undefined : (decoded.args[2] as bigint);
        if (collateralOperation ? assets === 0n : (assets === 0n) === (shares === 0n)) {
            return unknown(
                transaction,
                'Morpho requires a non-zero collateral amount or exactly one of assets and shares.'
            );
        }
        const beneficiary = address((collateralOperation ? decoded.args[2] : decoded.args[3]) as Address);
        const finalArg = collateralOperation ? decoded.args[3] : decoded.args[4];
        const receiver =
            operation === 'withdraw' || operation === 'borrow' || operation === 'withdraw-collateral'
                ? address(finalArg as Address)
                : undefined;
        const callbackData = receiver ? '0x' : (finalArg as Hex);
        const action: MorphoAction = {
            kind: 'morpho',
            index: 0,
            operation,
            marketId: morphoMarketId(params),
            marketParams: params,
            beneficiary,
            ...(receiver ? { receiver } : {}),
            assets: amount(assets, shares),
            ...(shares === undefined ? {} : { shares: { value: shares.toString(), mode: 'exact' } }),
            callbackData
        };
        return {
            schemaVersion: '1.0',
            protocol: 'morpho',
            adapter: 'morpho-blue-v1',
            chainId: transaction.chainId,
            sender: transaction.from,
            target: transaction.to,
            nativeValue: transaction.value,
            transactionFingerprint: transactionFingerprint(transaction),
            actions: [action],
            expectedBalanceChanges: morphoBalanceChanges(action),
            warnings: ['Share-denominated operations require fixed-block simulation to resolve exact asset amounts.'],
            ...(transaction.source ? { source: transaction.source } : {})
        };
    } catch {
        return unknown(transaction, `Unsupported Morpho selector ${transaction.data.slice(0, 10)}`);
    }
}
