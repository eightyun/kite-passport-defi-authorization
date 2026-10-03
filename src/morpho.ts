import { createPublicClient, decodeAbiParameters, getAddress, parseAbi, parseAbiParameters } from 'viem';
import { morphoBalanceChanges } from './adapters/morpho.js';
import { BASE_CHAIN_ID, BASE_MORPHO } from './contracts.js';
import type {
    Address,
    IntentAnalysis,
    MorphoAction,
    MorphoExposure,
    MorphoPreflight,
    SimulationResult,
    TransactionEnvelope
} from './domain.js';
import { transactionFingerprint } from './permit2.js';
import { rpcTransport } from './rpc.js';

const morphoStateAbi = parseAbi([
    'function idToMarketParams(bytes32 id) view returns (address loanToken,address collateralToken,address oracle,address irm,uint256 lltv)',
    'function position(bytes32 id,address user) view returns (uint256 supplyShares,uint128 borrowShares,uint128 collateral)',
    'function market(bytes32 id) view returns (uint128 totalSupplyAssets,uint128 totalSupplyShares,uint128 totalBorrowAssets,uint128 totalBorrowShares,uint128 lastUpdate,uint128 fee)',
    'function isAuthorized(address authorizer,address authorized) view returns (bool)'
]);

function accountFor(action: MorphoAction): Address {
    return getAddress(action.beneficiary) as Address;
}

function paramsMatch(action: MorphoAction, actual: readonly [Address, Address, Address, Address, bigint]): boolean {
    const expected = action.marketParams;
    return (
        expected.loanToken.toLowerCase() === actual[0].toLowerCase() &&
        expected.collateralToken.toLowerCase() === actual[1].toLowerCase() &&
        expected.oracle.toLowerCase() === actual[2].toLowerCase() &&
        expected.irm.toLowerCase() === actual[3].toLowerCase() &&
        BigInt(expected.lltv) === actual[4]
    );
}

export async function preflightMorpho(
    transaction: TransactionEnvelope,
    intent: IntentAnalysis,
    rpcUrl: string,
    requestedBlock?: bigint
): Promise<MorphoPreflight> {
    const fingerprint = transactionFingerprint(transaction);
    if (!intent.actions.length || intent.actions.some((action) => action.kind !== 'morpho')) {
        return {
            transactionFingerprint: fingerprint,
            status: 'invalid',
            exposures: [],
            error: 'Unsupported Morpho operation.'
        };
    }
    const client = createPublicClient({ transport: rpcTransport(rpcUrl) });
    try {
        if (transaction.chainId !== BASE_CHAIN_ID || (await client.getChainId()) !== BASE_CHAIN_ID) {
            throw new Error('Unsupported RPC chain');
        }
        const block = await client.getBlock(requestedBlock === undefined ? {} : { blockNumber: requestedBlock });
        if (!block.hash || block.number === null) throw new Error('Unconfirmed block');
        const exposures: MorphoExposure[] = [];
        for (const candidate of intent.actions) {
            if (candidate.kind !== 'morpho') continue;
            const action = candidate;
            const args = { address: BASE_MORPHO, abi: morphoStateAbi, blockNumber: block.number } as const;
            // Pin every read to one block so account and market state cannot come from different heights.
            const actualParams = await client.readContract({
                ...args,
                functionName: 'idToMarketParams',
                args: [action.marketId]
            });
            if (!paramsMatch(action, actualParams)) {
                return {
                    transactionFingerprint: fingerprint,
                    status: 'invalid',
                    exposures: [],
                    error: 'Morpho market parameters do not match the canonical market ID.'
                };
            }
            const account = accountFor(action);
            if (account.toLowerCase() !== transaction.from.toLowerCase()) {
                const authorized = await client.readContract({
                    ...args,
                    functionName: 'isAuthorized',
                    args: [account, transaction.from]
                });
                if (!authorized) {
                    return {
                        transactionFingerprint: fingerprint,
                        status: 'invalid',
                        exposures: [],
                        error: 'Sender is not authorized to act for the Morpho beneficiary.'
                    };
                }
            }
            const position = await client.readContract({
                ...args,
                functionName: 'position',
                args: [action.marketId, account]
            });
            const market = await client.readContract({ ...args, functionName: 'market', args: [action.marketId] });
            exposures.push({
                actionIndex: action.index,
                marketId: action.marketId,
                account,
                loanToken: action.marketParams.loanToken,
                collateralToken: action.marketParams.collateralToken,
                operation: action.operation,
                assets: action.assets.mode === 'exact' ? action.assets.value : '0',
                shares: action.shares?.value ?? '0',
                supplySharesBefore: position[0].toString(),
                supplySharesAfter: position[0].toString(),
                borrowSharesBefore: position[1].toString(),
                borrowSharesAfter: position[1].toString(),
                collateralBefore: position[2].toString(),
                collateralAfter: position[2].toString(),
                totalSupplyAssets: market[0].toString(),
                totalSupplyShares: market[1].toString(),
                totalBorrowAssets: market[2].toString(),
                totalBorrowShares: market[3].toString()
            });
        }
        if ((await client.getBlock({ blockNumber: block.number })).hash !== block.hash)
            throw new Error('Block changed');
        return {
            transactionFingerprint: fingerprint,
            status: 'ready',
            blockNumber: block.number.toString(),
            blockHash: block.hash,
            blockTimestamp: Number(block.timestamp),
            exposures
        };
    } catch {
        return {
            transactionFingerprint: fingerprint,
            status: 'unavailable',
            exposures: [],
            error: 'Unable to verify Morpho market identity, authorization, position and totals at a fixed block.'
        };
    }
}

function resultAmounts(action: MorphoAction, simulation: SimulationResult): readonly [bigint, bigint] | undefined {
    if (action.operation === 'supply-collateral' || action.operation === 'withdraw-collateral') {
        return [BigInt(action.assets.value), 0n];
    }
    if (!simulation.returnData) return undefined;
    try {
        return decodeAbiParameters(parseAbiParameters('uint256 assets,uint256 shares'), simulation.returnData);
    } catch {
        return undefined;
    }
}

export function resolveMorpho(
    intent: IntentAnalysis,
    state: MorphoPreflight,
    simulation: SimulationResult
): { readonly intent: IntentAnalysis; readonly state: MorphoPreflight } {
    if (
        state.status !== 'ready' ||
        state.transactionFingerprint !== intent.transactionFingerprint ||
        !simulation.attempted ||
        !simulation.success ||
        simulation.transactionFingerprint !== state.transactionFingerprint ||
        simulation.blockNumber !== state.blockNumber ||
        simulation.blockHash !== state.blockHash
    ) {
        return { intent, state };
    }
    let invalid: string | undefined;
    const exposures = state.exposures.map((entry) => {
        const action = intent.actions.find(
            (candidate) => candidate.kind === 'morpho' && candidate.index === entry.actionIndex
        );
        if (action?.kind !== 'morpho') return entry;
        const result = resultAmounts(action, simulation);
        if (!result) {
            invalid = 'Morpho simulation returned malformed operation amounts.';
            return entry;
        }
        const [assets, shares] = result;
        let supply = BigInt(entry.supplySharesBefore);
        let borrow = BigInt(entry.borrowSharesBefore);
        let collateral = BigInt(entry.collateralBefore);
        if (action.operation === 'supply') supply += shares;
        if (action.operation === 'withdraw') supply -= shares;
        if (action.operation === 'borrow') borrow += shares;
        if (action.operation === 'repay') borrow -= shares;
        if (action.operation === 'supply-collateral') collateral += assets;
        if (action.operation === 'withdraw-collateral') collateral -= assets;
        if (supply < 0n || borrow < 0n || collateral < 0n)
            invalid = 'Morpho operation exceeds the verified account position.';
        return {
            ...entry,
            assets: assets.toString(),
            shares: shares.toString(),
            supplySharesAfter: supply.toString(),
            borrowSharesAfter: borrow.toString(),
            collateralAfter: collateral.toString()
        };
    });
    if (invalid) return { intent, state: { ...state, status: 'invalid', error: invalid, exposures } };
    const actions = intent.actions.map((candidate) => {
        if (candidate.kind !== 'morpho') return candidate;
        const exposure = exposures.find((entry) => entry.actionIndex === candidate.index)!;
        return {
            ...candidate,
            assets: { value: exposure.assets, mode: 'exact' as const },
            shares: { value: exposure.shares, mode: 'exact' as const }
        };
    });
    return {
        intent: {
            ...intent,
            actions,
            expectedBalanceChanges: actions.flatMap((action) =>
                action.kind === 'morpho' ? morphoBalanceChanges(action) : []
            ),
            warnings: [
                'Morpho asset and share deltas are conditional on successful simulation at the verified fixed block.'
            ]
        },
        state: { ...state, exposures }
    };
}

export function morphoStateMatches(
    intent: IntentAnalysis,
    state: MorphoPreflight | undefined,
    simulation: SimulationResult
): boolean {
    return (
        state?.status === 'ready' &&
        state.transactionFingerprint === intent.transactionFingerprint &&
        simulation.success &&
        simulation.transactionFingerprint === state.transactionFingerprint &&
        simulation.blockNumber === state.blockNumber &&
        simulation.blockHash === state.blockHash &&
        intent.actions.every(
            (action) => action.kind !== 'morpho' || state.exposures.some((entry) => entry.actionIndex === action.index)
        )
    );
}
