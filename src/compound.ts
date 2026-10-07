import { createPublicClient, getAddress, parseAbi, recoverTypedDataAddress } from 'viem';
import { compoundBalanceChanges } from './adapters/compound.js';
import { BASE_CHAIN_ID, BASE_COMPOUND_USDC_COMET } from './contracts.js';
import type {
    Address,
    CompoundAction,
    CompoundExposure,
    CompoundOperation,
    CompoundPreflight,
    IntentAnalysis,
    PolicyReasonCode,
    SimulationResult,
    TransactionEnvelope
} from './domain.js';
import { transactionFingerprint } from './permit2.js';
import { rpcTransport } from './rpc.js';

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as Address;
const FACTOR_SCALE = 10n ** 18n;

const cometStateAbi = parseAbi([
    'function baseToken() view returns (address)',
    'function baseTokenPriceFeed() view returns (address)',
    'function baseScale() view returns (uint256)',
    'function baseBorrowMin() view returns (uint256)',
    'function numAssets() view returns (uint8)',
    'function name() view returns (string)',
    'function version() view returns (string)',
    'function isSupplyPaused() view returns (bool)',
    'function isWithdrawPaused() view returns (bool)',
    'function balanceOf(address account) view returns (uint256)',
    'function borrowBalanceOf(address account) view returns (uint256)',
    'function hasPermission(address owner,address manager) view returns (bool)',
    'function isAllowed(address owner,address manager) view returns (bool)',
    'function userNonce(address owner) view returns (uint256)',
    'function collateralBalanceOf(address account,address asset) view returns (uint128)',
    'function totalsCollateral(address asset) view returns (uint128 totalSupplyAsset,uint128 reserved)',
    'function getPrice(address priceFeed) view returns (uint256)',
    'function getAssetInfo(uint8 index) view returns ((uint8 offset,address asset,address priceFeed,uint64 scale,uint64 borrowCollateralFactor,uint64 liquidateCollateralFactor,uint64 liquidationFactor,uint128 supplyCap))'
]);

interface AssetSnapshot {
    readonly asset: Address;
    readonly priceFeed: Address;
    readonly scale: bigint;
    readonly borrowCollateralFactor: bigint;
    readonly liquidateCollateralFactor: bigint;
    readonly supplyCap: bigint;
    readonly balance: bigint;
    readonly totalSupply: bigint;
    readonly price: bigint;
}

function invalid(fingerprint: `0x${string}`, code: PolicyReasonCode, error: string): CompoundPreflight {
    return { transactionFingerprint: fingerprint, status: 'invalid', exposures: [], errorCode: code, error };
}

function semanticOperation(
    action: CompoundAction,
    baseToken: Address,
    amount: bigint,
    baseSupplyBefore: bigint,
    baseBorrowBefore: bigint
): CompoundOperation {
    if (!action.asset || action.asset.toLowerCase() !== baseToken.toLowerCase()) return action.operation;
    if (action.method.startsWith('supply')) {
        const repaid = amount > baseBorrowBefore ? baseBorrowBefore : amount;
        const supplied = amount - repaid;
        if (repaid > 0n && supplied > 0n) return 'repay-and-supply-base';
        return repaid > 0n ? 'repay-base' : 'supply-base';
    }
    const withdrawn = amount > baseSupplyBefore ? baseSupplyBefore : amount;
    const borrowed = amount - withdrawn;
    if (withdrawn > 0n && borrowed > 0n) return 'withdraw-and-borrow-base';
    return borrowed > 0n ? 'borrow-base' : 'withdraw-base';
}

function capacityInBase(
    assets: readonly AssetSnapshot[],
    selectedAsset: Address | undefined,
    selectedBalanceAfter: bigint,
    basePrice: bigint,
    baseScale: bigint,
    factor: 'borrow' | 'liquidation'
): bigint {
    let value = 0n;
    for (const asset of assets) {
        const balance =
            selectedAsset?.toLowerCase() === asset.asset.toLowerCase() ? selectedBalanceAfter : asset.balance;
        const collateralValue = (balance * asset.price) / asset.scale;
        const collateralFactor = factor === 'borrow' ? asset.borrowCollateralFactor : asset.liquidateCollateralFactor;
        value += (collateralValue * collateralFactor) / FACTOR_SCALE;
    }
    return (value * baseScale) / basePrice;
}

async function verifyAllowBySig(
    action: CompoundAction,
    name: string,
    version: string,
    blockTimestamp: bigint,
    nonceBefore: bigint
): Promise<PolicyReasonCode | undefined> {
    if (!action.signature || action.nonce === undefined || action.expiry === undefined || !action.manager) {
        return 'COMPOUND_SIGNATURE_INVALID';
    }
    if (BigInt(action.expiry) <= blockTimestamp) return 'COMPOUND_SIGNATURE_EXPIRED';
    if (BigInt(action.nonce) !== nonceBefore) return 'COMPOUND_NONCE_MISMATCH';
    try {
        const signer = getAddress(
            await recoverTypedDataAddress({
                domain: { name, version, chainId: BASE_CHAIN_ID, verifyingContract: BASE_COMPOUND_USDC_COMET },
                types: {
                    Authorization: [
                        { name: 'owner', type: 'address' },
                        { name: 'manager', type: 'address' },
                        { name: 'isAllowed', type: 'bool' },
                        { name: 'nonce', type: 'uint256' },
                        { name: 'expiry', type: 'uint256' }
                    ]
                },
                primaryType: 'Authorization',
                message: {
                    owner: action.account,
                    manager: action.manager,
                    isAllowed: action.isAllowed ?? false,
                    nonce: BigInt(action.nonce),
                    expiry: BigInt(action.expiry)
                },
                signature: action.signature
            })
        );
        return signer.toLowerCase() === action.account.toLowerCase() ? undefined : 'COMPOUND_SIGNATURE_INVALID';
    } catch {
        return 'COMPOUND_SIGNATURE_INVALID';
    }
}

export async function preflightCompound(
    transaction: TransactionEnvelope,
    intent: IntentAnalysis,
    rpcUrl: string,
    requestedBlock?: bigint
): Promise<CompoundPreflight> {
    const fingerprint = transactionFingerprint(transaction);
    if (intent.actions.length !== 1 || intent.actions[0]?.kind !== 'compound') {
        return invalid(
            fingerprint,
            'COMPOUND_PRECHECK_FAILED',
            'Compound transactions must contain one supported Comet operation.'
        );
    }
    const action = intent.actions[0];
    const client = createPublicClient({ transport: rpcTransport(rpcUrl) });
    try {
        if (transaction.chainId !== BASE_CHAIN_ID || (await client.getChainId()) !== BASE_CHAIN_ID)
            throw new Error('Unsupported RPC chain');
        const block = await client.getBlock(requestedBlock === undefined ? {} : { blockNumber: requestedBlock });
        if (!block.hash || block.number === null) throw new Error('Unconfirmed block');
        const manager = action.manager ?? action.operator;
        const permissionOwner = action.method === 'supplyFrom' ? action.source : action.account;
        const result = await client.multicall({
            allowFailure: false,
            blockNumber: block.number,
            multicallAddress: MULTICALL3,
            contracts: [
                { address: BASE_COMPOUND_USDC_COMET, abi: cometStateAbi, functionName: 'baseToken' },
                { address: BASE_COMPOUND_USDC_COMET, abi: cometStateAbi, functionName: 'baseTokenPriceFeed' },
                { address: BASE_COMPOUND_USDC_COMET, abi: cometStateAbi, functionName: 'baseScale' },
                { address: BASE_COMPOUND_USDC_COMET, abi: cometStateAbi, functionName: 'baseBorrowMin' },
                { address: BASE_COMPOUND_USDC_COMET, abi: cometStateAbi, functionName: 'numAssets' },
                { address: BASE_COMPOUND_USDC_COMET, abi: cometStateAbi, functionName: 'name' },
                { address: BASE_COMPOUND_USDC_COMET, abi: cometStateAbi, functionName: 'version' },
                { address: BASE_COMPOUND_USDC_COMET, abi: cometStateAbi, functionName: 'isSupplyPaused' },
                { address: BASE_COMPOUND_USDC_COMET, abi: cometStateAbi, functionName: 'isWithdrawPaused' },
                {
                    address: BASE_COMPOUND_USDC_COMET,
                    abi: cometStateAbi,
                    functionName: 'balanceOf',
                    args: [action.account]
                },
                {
                    address: BASE_COMPOUND_USDC_COMET,
                    abi: cometStateAbi,
                    functionName: 'borrowBalanceOf',
                    args: [action.account]
                },
                {
                    address: BASE_COMPOUND_USDC_COMET,
                    abi: cometStateAbi,
                    functionName: 'hasPermission',
                    args: [permissionOwner, action.operator]
                },
                {
                    address: BASE_COMPOUND_USDC_COMET,
                    abi: cometStateAbi,
                    functionName: 'isAllowed',
                    args: [action.account, manager]
                },
                {
                    address: BASE_COMPOUND_USDC_COMET,
                    abi: cometStateAbi,
                    functionName: 'userNonce',
                    args: [action.account]
                }
            ]
        });
        const [
            baseTokenRaw,
            basePriceFeed,
            baseScale,
            baseBorrowMinimum,
            numAssets,
            name,
            version,
            supplyPaused,
            withdrawPaused,
            baseSupplyBefore,
            baseBorrowBefore,
            permissionBefore,
            managerAllowedBefore,
            nonceBefore
        ] = result;
        const baseToken = getAddress(baseTokenRaw) as Address;
        if (baseToken.toLowerCase() !== '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913') {
            return invalid(
                fingerprint,
                'COMPOUND_MARKET_MISMATCH',
                'Compound Comet base token does not match the canonical Base USDC market.'
            );
        }
        if (action.method.startsWith('supply') && supplyPaused)
            return invalid(fingerprint, 'COMPOUND_SUPPLY_PAUSED', 'Compound III supply is paused.');
        if (action.method.startsWith('withdraw') && withdrawPaused)
            return invalid(fingerprint, 'COMPOUND_WITHDRAW_PAUSED', 'Compound III withdrawal is paused.');
        if ((action.method === 'supplyFrom' || action.method === 'withdrawFrom') && !permissionBefore) {
            return invalid(
                fingerprint,
                'COMPOUND_OPERATOR_NOT_ALLOWED',
                'Compound III operator lacks account permission.'
            );
        }
        const signatureError =
            action.method === 'allowBySig'
                ? await verifyAllowBySig(action, name, version, block.timestamp, nonceBefore)
                : undefined;
        if (signatureError)
            return invalid(
                fingerprint,
                signatureError,
                `Compound III ${signatureError.toLowerCase().replaceAll('_', ' ')}.`
            );

        const rawAssetInfo = await client.multicall({
            allowFailure: false,
            blockNumber: block.number,
            multicallAddress: MULTICALL3,
            contracts: Array.from({ length: numAssets }, (_, index) => ({
                address: BASE_COMPOUND_USDC_COMET,
                abi: cometStateAbi,
                functionName: 'getAssetInfo' as const,
                args: [index]
            }))
        });
        const assetReads = rawAssetInfo.flatMap((info) => [
            {
                address: BASE_COMPOUND_USDC_COMET,
                abi: cometStateAbi,
                functionName: 'collateralBalanceOf' as const,
                args: [action.account, info.asset]
            },
            {
                address: BASE_COMPOUND_USDC_COMET,
                abi: cometStateAbi,
                functionName: 'totalsCollateral' as const,
                args: [info.asset]
            },
            {
                address: BASE_COMPOUND_USDC_COMET,
                abi: cometStateAbi,
                functionName: 'getPrice' as const,
                args: [info.priceFeed]
            }
        ]);
        const values = assetReads.length
            ? await client.multicall({
                  allowFailure: false,
                  blockNumber: block.number,
                  multicallAddress: MULTICALL3,
                  contracts: assetReads
              })
            : [];
        const assets: AssetSnapshot[] = rawAssetInfo.map((info, index) => ({
            asset: getAddress(info.asset) as Address,
            priceFeed: getAddress(info.priceFeed) as Address,
            scale: info.scale,
            borrowCollateralFactor: info.borrowCollateralFactor,
            liquidateCollateralFactor: info.liquidateCollateralFactor,
            supplyCap: info.supplyCap,
            balance: values[index * 3] as bigint,
            totalSupply: (values[index * 3 + 1] as readonly [bigint, bigint])[0],
            price: values[index * 3 + 2] as bigint
        }));
        const basePrice = await client.readContract({
            address: BASE_COMPOUND_USDC_COMET,
            abi: cometStateAbi,
            functionName: 'getPrice',
            args: [basePriceFeed],
            blockNumber: block.number
        });
        if (basePrice === 0n) throw new Error('Missing Compound base price');
        const selected =
            action.asset && action.asset.toLowerCase() !== baseToken.toLowerCase()
                ? assets.find((entry) => entry.asset.toLowerCase() === action.asset!.toLowerCase())
                : undefined;
        if (action.asset && action.asset.toLowerCase() !== baseToken.toLowerCase() && !selected) {
            return invalid(
                fingerprint,
                'COMPOUND_ASSET_NOT_ALLOWED',
                'Asset is not listed in the Compound III market.'
            );
        }
        let amount = action.amount?.mode === 'all' ? undefined : BigInt(action.amount?.value ?? '0');
        if (action.amount?.mode === 'all') {
            if (action.asset?.toLowerCase() !== baseToken.toLowerCase())
                return invalid(
                    fingerprint,
                    'COMPOUND_PRECHECK_FAILED',
                    'Maximum amount is only supported for Compound base supply or withdrawal.'
                );
            amount = action.method.startsWith('supply') ? baseBorrowBefore : baseSupplyBefore;
        }
        amount ??= 0n;
        if (action.amount && amount === 0n)
            return invalid(
                fingerprint,
                'COMPOUND_PRECHECK_FAILED',
                'Compound III operation resolves to a zero amount.'
            );
        let baseSupplyAfter = baseSupplyBefore;
        let baseBorrowAfter = baseBorrowBefore;
        let collateralBefore = selected?.balance ?? 0n;
        let collateralAfter = collateralBefore;
        let totalCollateralAfter = selected?.totalSupply ?? 0n;
        if (action.asset?.toLowerCase() === baseToken.toLowerCase()) {
            if (action.method.startsWith('supply')) {
                const repaid = amount > baseBorrowBefore ? baseBorrowBefore : amount;
                baseBorrowAfter -= repaid;
                baseSupplyAfter += amount - repaid;
            } else {
                const withdrawn = amount > baseSupplyBefore ? baseSupplyBefore : amount;
                baseSupplyAfter -= withdrawn;
                baseBorrowAfter += amount - withdrawn;
            }
        } else if (selected && action.method.startsWith('supply')) {
            collateralAfter += amount;
            totalCollateralAfter += amount;
            if (totalCollateralAfter > selected.supplyCap)
                return invalid(
                    fingerprint,
                    'COMPOUND_SUPPLY_CAP_EXCEEDED',
                    'Compound III collateral supply would exceed the asset cap.'
                );
        } else if (selected) {
            if (amount > collateralBefore)
                return invalid(
                    fingerprint,
                    'COMPOUND_PRECHECK_FAILED',
                    'Compound III collateral withdrawal exceeds the verified balance.'
                );
            collateralAfter -= amount;
            totalCollateralAfter -= amount;
        }
        const operation = semanticOperation(action, baseToken, amount, baseSupplyBefore, baseBorrowBefore);
        const borrowCapacityBefore = capacityInBase(assets, undefined, 0n, basePrice, baseScale, 'borrow');
        const liquidationCapacityBefore = capacityInBase(assets, undefined, 0n, basePrice, baseScale, 'liquidation');
        const borrowCapacityAfter = capacityInBase(
            assets,
            selected?.asset,
            collateralAfter,
            basePrice,
            baseScale,
            'borrow'
        );
        const liquidationCapacityAfter = capacityInBase(
            assets,
            selected?.asset,
            collateralAfter,
            basePrice,
            baseScale,
            'liquidation'
        );
        if (baseBorrowAfter > baseBorrowBefore && baseBorrowAfter > 0n && baseBorrowAfter < baseBorrowMinimum)
            return invalid(
                fingerprint,
                'COMPOUND_BORROW_TOO_SMALL',
                'Compound III projected base borrow is below the market minimum.'
            );
        if (
            (baseBorrowAfter > baseBorrowBefore || collateralAfter < collateralBefore) &&
            baseBorrowAfter > borrowCapacityAfter
        )
            return invalid(
                fingerprint,
                'COMPOUND_NOT_COLLATERALIZED',
                'Compound III projected borrow exceeds collateral capacity.'
            );
        const exposure: CompoundExposure = {
            actionIndex: action.index,
            operation,
            method: action.method,
            market: action.market,
            baseToken,
            ...(action.asset ? { asset: action.asset } : {}),
            account: action.account,
            source: action.source,
            recipient: action.recipient ?? action.account,
            amount: amount.toString(),
            baseSupplyBefore: baseSupplyBefore.toString(),
            baseSupplyAfter: baseSupplyAfter.toString(),
            baseBorrowBefore: baseBorrowBefore.toString(),
            baseBorrowAfter: baseBorrowAfter.toString(),
            collateralBalanceBefore: collateralBefore.toString(),
            collateralBalanceAfter: collateralAfter.toString(),
            totalCollateralBefore: (selected?.totalSupply ?? 0n).toString(),
            totalCollateralAfter: totalCollateralAfter.toString(),
            ...(selected ? { collateralSupplyCap: selected.supplyCap.toString() } : {}),
            borrowCapacityBaseBefore: borrowCapacityBefore.toString(),
            borrowCapacityBaseAfter: borrowCapacityAfter.toString(),
            liquidationCapacityBaseBefore: liquidationCapacityBefore.toString(),
            liquidationCapacityBaseAfter: liquidationCapacityAfter.toString(),
            baseBorrowMinimum: baseBorrowMinimum.toString(),
            permissionBefore,
            ...(action.manager
                ? { manager: action.manager, managerAllowedBefore, managerAllowedAfter: action.isAllowed ?? false }
                : {}),
            ...(action.method === 'allowBySig' ? { nonceBefore: nonceBefore.toString(), signatureValid: true } : {})
        };
        if ((await client.getBlock({ blockNumber: block.number })).hash !== block.hash)
            throw new Error('Block changed');
        return {
            transactionFingerprint: fingerprint,
            status: 'ready',
            blockNumber: block.number.toString(),
            blockHash: block.hash,
            blockTimestamp: Number(block.timestamp),
            exposures: [exposure]
        };
    } catch {
        return {
            transactionFingerprint: fingerprint,
            status: 'unavailable',
            exposures: [],
            error: 'Unable to verify Compound III market, account and permission state at a fixed block.'
        };
    }
}

export function compoundStateMatches(
    intent: IntentAnalysis,
    state: CompoundPreflight | undefined,
    simulation: SimulationResult
): boolean {
    return (
        state?.status === 'ready' &&
        state.transactionFingerprint === intent.transactionFingerprint &&
        simulation.attempted &&
        simulation.success &&
        simulation.transactionFingerprint === state.transactionFingerprint &&
        simulation.blockNumber === state.blockNumber &&
        simulation.blockHash === state.blockHash &&
        intent.actions.every(
            (action) =>
                action.kind !== 'compound' || state.exposures.some((entry) => entry.actionIndex === action.index)
        )
    );
}

export function resolveCompoundIntent(
    intent: IntentAnalysis,
    state: CompoundPreflight,
    simulation: SimulationResult
): IntentAnalysis {
    if (!compoundStateMatches(intent, state, simulation)) return intent;
    const actions = intent.actions.map((candidate) => {
        if (candidate.kind !== 'compound') return candidate;
        const exposure = state.exposures.find((entry) => entry.actionIndex === candidate.index)!;
        return {
            ...candidate,
            operation: exposure.operation,
            ...(candidate.amount ? { amount: { value: exposure.amount, mode: 'exact' as const } } : {})
        };
    });
    return {
        ...intent,
        actions,
        expectedBalanceChanges: actions.flatMap((action) =>
            action.kind === 'compound'
                ? compoundBalanceChanges(
                      action,
                      state.exposures.find((entry) => entry.actionIndex === action.index)
                  )
                : []
        ),
        warnings: [
            'Compound III balance, debt, collateral and permission changes are conditional projections at the verified fixed block.'
        ]
    };
}
