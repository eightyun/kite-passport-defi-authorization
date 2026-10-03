import { rpcTransport } from './rpc.js';
import { createPublicClient, parseAbi } from 'viem';
import { BASE_CHAIN_ID, BASE_MOONWELL_COMPTROLLER, findMoonwellMarket } from './contracts.js';
import type {
    Address,
    IntentAnalysis,
    MoonwellExposure,
    MoonwellPreflight,
    SimulationResult,
    TransactionEnvelope
} from './domain.js';
import { transactionFingerprint } from './permit2.js';
import { marketBalanceChanges } from './adapters/moonwell.js';

const scale = 10n ** 18n;
const marketAbi = parseAbi([
    'function exchangeRateCurrent() returns (uint256)',
    'function borrowBalanceCurrent(address account) returns (uint256)',
    'function balanceOf(address account) view returns (uint256)',
    'function underlying() view returns (address)',
    'function comptroller() view returns (address)'
]);
const controllerAbi = parseAbi(['function checkMembership(address account, address market) view returns (bool)']);

export async function preflightMoonwell(
    transaction: TransactionEnvelope,
    intent: IntentAnalysis,
    rpcUrl: string,
    requestedBlock?: bigint
): Promise<MoonwellPreflight> {
    const fingerprint = transactionFingerprint(transaction);
    if (!intent.actions.length || intent.actions.some((action) => action.kind !== 'lending')) {
        return {
            transactionFingerprint: fingerprint,
            status: 'invalid',
            exposures: [],
            error: 'Unsupported Moonwell operation.'
        };
    }
    const client = createPublicClient({
        transport: rpcTransport(rpcUrl)
    });
    try {
        if (transaction.chainId !== BASE_CHAIN_ID || (await client.getChainId()) !== BASE_CHAIN_ID) {
            throw new Error('Unsupported RPC chain');
        }
        const block = await client.getBlock(requestedBlock === undefined ? {} : { blockNumber: requestedBlock });
        if (!block.hash || block.number === null) throw new Error('Unconfirmed block');
        const exposures: MoonwellExposure[] = [];
        const atBlock = { blockNumber: block.number };
        for (const action of intent.actions) {
            if (action.kind !== 'lending') continue;
            const metadata = findMoonwellMarket(action.market);
            if (!metadata)
                return {
                    transactionFingerprint: fingerprint,
                    status: 'invalid',
                    exposures: [],
                    error: 'Unregistered Moonwell market.'
                };
            const account = action.beneficiary === 'sender' ? transaction.from : (action.beneficiary as Address);
            const params = { address: action.market, abi: marketAbi, ...atBlock };
            // Read entries sequentially to avoid bursting concurrent state queries at public RPC endpoints.
            const { result: rate } = await client.simulateContract({
                ...params,
                functionName: 'exchangeRateCurrent'
            });
            const { result: debt } = await client.simulateContract({
                ...params,
                functionName: 'borrowBalanceCurrent',
                args: [account]
            });
            const receiptBalance = await client.readContract({
                ...params,
                functionName: 'balanceOf',
                args: [account]
            });
            const underlying = await client.readContract({
                ...params,
                functionName: 'underlying'
            });
            const controller = await client.readContract({
                ...params,
                functionName: 'comptroller'
            });
            const membership = await client.readContract({
                address: BASE_MOONWELL_COMPTROLLER,
                abi: controllerAbi,
                functionName: 'checkMembership',
                args: [account, action.market],
                ...atBlock
            });
            if (
                rate === 0n ||
                underlying.toLowerCase() !== metadata.underlying.toLowerCase() ||
                controller.toLowerCase() !== BASE_MOONWELL_COMPTROLLER.toLowerCase()
            )
                throw new Error('Invalid market metadata');
            // A market may appear more than once in enterMarkets; later entries reuse the previous membership state.
            const previous = [...exposures]
                .reverse()
                .find((entry) => entry.market.toLowerCase() === action.market.toLowerCase());
            const beforeCollateral = previous?.collateralEnabledAfter ?? membership;
            let afterCollateral = beforeCollateral;
            let underlyingAmount = 0n;
            let receiptAmount = 0n;
            let afterReceipt = receiptBalance;
            let afterDebt = debt;
            const raw =
                action.amount?.mode === 'all'
                    ? undefined
                    : action.amount === undefined
                      ? 0n
                      : BigInt(action.amount.value);
            // Match the contract's 1e18 fixed-point arithmetic and floor rounding instead of dividing display units.
            if (action.operation === 'supply') {
                if (raw === undefined) throw new Error('Mint does not support an all sentinel');
                underlyingAmount = raw;
                receiptAmount = (raw * scale) / rate;
                afterReceipt += receiptAmount;
            } else if (action.operation === 'withdraw') {
                if (raw === undefined) {
                    receiptAmount = receiptBalance;
                    underlyingAmount = (receiptAmount * rate) / scale;
                } else if (action.amountAsset?.toLowerCase() === action.market.toLowerCase()) {
                    receiptAmount = raw;
                    underlyingAmount = (raw * rate) / scale;
                } else {
                    underlyingAmount = raw;
                    receiptAmount = (raw * scale) / rate;
                }
                afterReceipt -= receiptAmount;
            } else if (action.operation === 'borrow') {
                if (raw === undefined) throw new Error('Borrow does not support an all sentinel');
                underlyingAmount = raw;
                afterDebt += raw;
                afterCollateral = true;
            } else if (action.operation === 'repay') {
                underlyingAmount = raw ?? debt;
                afterDebt -= underlyingAmount;
            } else {
                afterCollateral = action.operation === 'enable-collateral';
            }
            if (afterReceipt < 0n || afterDebt < 0n)
                return {
                    transactionFingerprint: fingerprint,
                    status: 'invalid',
                    exposures: [],
                    error: 'Requested redemption exceeds receipt balance or repayment exceeds accrued debt.'
                };
            const suppliedBefore = (receiptBalance * rate) / scale;
            const suppliedAfter = (afterReceipt * rate) / scale;
            exposures.push({
                actionIndex: action.index,
                market: action.market,
                account,
                underlying: metadata.underlying,
                exchangeRateMantissa: rate.toString(),
                underlyingAmount: underlyingAmount.toString(),
                receiptAmount: receiptAmount.toString(),
                receiptBalanceBefore: receiptBalance.toString(),
                receiptBalanceAfter: afterReceipt.toString(),
                suppliedUnderlyingBefore: suppliedBefore.toString(),
                suppliedUnderlyingAfter: suppliedAfter.toString(),
                debtBefore: debt.toString(),
                debtAfter: afterDebt.toString(),
                collateralEnabledBefore: beforeCollateral,
                collateralEnabledAfter: afterCollateral,
                collateralUnderlyingBefore: (beforeCollateral ? suppliedBefore : 0n).toString(),
                collateralUnderlyingAfter: (afterCollateral ? suppliedAfter : 0n).toString()
            });
        }
        if ((await client.getBlock(atBlock)).hash !== block.hash) throw new Error('Block changed');
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
            error: 'Unable to verify Moonwell market metadata, accrued exchange rate or account state at a fixed block.'
        };
    }
}

export function moonwellStateMatches(
    intent: IntentAnalysis,
    state: MoonwellPreflight | undefined,
    simulation: SimulationResult
): boolean {
    return (
        state?.status === 'ready' &&
        state.transactionFingerprint === intent.transactionFingerprint &&
        simulation.attempted &&
        simulation.success &&
        simulation.blockNumber === state.blockNumber &&
        simulation.transactionFingerprint === state.transactionFingerprint &&
        state.blockHash !== undefined &&
        state.blockHash === simulation.blockHash &&
        intent.actions.every(
            (action) =>
                action.kind !== 'lending' ||
                state.exposures.some(
                    (entry) =>
                        entry.actionIndex === action.index && entry.market.toLowerCase() === action.market.toLowerCase()
                )
        )
    );
}

export function resolveMoonwellIntent(
    intent: IntentAnalysis,
    state: MoonwellPreflight,
    simulation: SimulationResult
): IntentAnalysis {
    if (!moonwellStateMatches(intent, state, simulation)) return intent;
    const actions = intent.actions.map((action) => {
        if (action.kind !== 'lending') return action;
        const exposure = state.exposures.find((entry) => entry.actionIndex === action.index)!;
        return {
            ...action,
            underlyingAmount: {
                value: exposure.underlyingAmount,
                mode: 'exact' as const
            },
            receiptAmount: { value: exposure.receiptAmount, mode: 'exact' as const }
        };
    });
    return {
        ...intent,
        actions,
        expectedBalanceChanges: actions.flatMap((action) =>
            action.kind === 'lending' ? marketBalanceChanges(action) : []
        ),
        warnings: [
            'Moonwell amounts are conditional predictions at the checked block using the accrued exchange rate; later state and rounding can change results.'
        ]
    };
}
