import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { decodeTransaction } from '../src/decode.js';
import { loadPolicy, loadTransaction } from '../src/io.js';
import { createAuthorizationReport } from '../src/report.js';
import { evaluatePolicy } from '../src/policy.js';
import type {
    AaveAction,
    AaveExposure,
    AavePreflight,
    IntentAnalysis,
    PolicyConfig,
    PolicyReasonCode,
    SimulationResult
} from '../src/domain.js';

const fixtures = resolve('fixtures/transactions');
const blockHash = `0x${'11'.repeat(32)}` as const;

function simulation(intent: IntentAnalysis): SimulationResult {
    return {
        attempted: true,
        success: true,
        blockNumber: '100',
        blockHash,
        transactionFingerprint: intent.transactionFingerprint!
    };
}

function exposure(action: AaveAction, overrides: Partial<AaveExposure> = {}): AaveExposure {
    return {
        actionIndex: action.index,
        operation: action.operation,
        asset: action.asset,
        account: action.beneficiary,
        recipient: action.recipient ?? action.beneficiary,
        amount: action.amount?.mode === 'all' ? '500000000' : (action.amount?.value ?? '0'),
        aToken: '0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB',
        variableDebtToken: '0x59dca05b6c26dbd64b5381374aAaC5CD05644C28',
        liquidityIndex: '1000000000000000000000000000',
        variableBorrowIndex: '1000000000000000000000000000',
        scaledATokenBalanceBefore: '1000000000',
        scaledATokenBalanceAfter: '1000000000',
        scaledVariableDebtBefore: '500000000',
        scaledVariableDebtAfter: '500000000',
        aTokenBalanceBefore: '1000000000',
        aTokenBalanceAfter: '1000000000',
        variableDebtBefore: '500000000',
        variableDebtAfter: '500000000',
        totalATokenBefore: '1000000000000',
        totalVariableDebtBefore: '500000000000',
        totalStableDebtBefore: '0',
        collateralEnabledBefore: true,
        collateralEnabledAfter: true,
        reserve: {
            decimals: 6,
            ltv: '7500',
            liquidationThreshold: '7800',
            usageAsCollateralEnabled: true,
            borrowingEnabled: true,
            active: true,
            frozen: false,
            paused: false,
            borrowCap: '207000000',
            supplyCap: '230000000',
            debtCeiling: '0',
            siloedBorrowing: false
        },
        accountBefore: {
            totalCollateralBase: '200000000000',
            totalDebtBase: '50000000000',
            availableBorrowsBase: '100000000000',
            currentLiquidationThreshold: '7800',
            ltv: '7500',
            healthFactor: '3120000000000000000'
        },
        accountAfter: {
            totalCollateralBase: '200000000000',
            totalDebtBase: '50000000000',
            availableBorrowsBase: '100000000000',
            currentLiquidationThreshold: '7800',
            ltv: '7500',
            healthFactor: '3120000000000000000'
        },
        ...overrides
    };
}

function state(intent: IntentAnalysis, entry: AaveExposure, overrides: Partial<AavePreflight> = {}): AavePreflight {
    return {
        transactionFingerprint: intent.transactionFingerprint!,
        status: 'ready',
        blockNumber: '100',
        blockHash,
        blockTimestamp: 1_791_296_000,
        exposures: [entry],
        ...overrides
    };
}

async function loaded(name: string): Promise<{
    intent: IntentAnalysis;
    action: AaveAction;
    policy: PolicyConfig;
}> {
    const transaction = await loadTransaction(resolve(fixtures, name));
    const intent = decodeTransaction(transaction);
    const action = intent.actions[0];
    assert.equal(action?.kind, 'aave');
    if (action?.kind !== 'aave') throw new Error('Expected Aave action');
    return { intent, action, policy: await loadPolicy('config/policy.example.json') };
}

test('decodes six real Base Aave Pool transaction vectors', async () => {
    const cases = [
        ['aave-supply-usdc.base.json', 'supply'],
        ['aave-withdraw-usdc.base.json', 'withdraw'],
        ['aave-borrow-usdc.base.json', 'borrow'],
        ['aave-repay-usdc.base.json', 'repay'],
        ['aave-enable-collateral-usdc.base.json', 'enable-collateral'],
        ['aave-disable-collateral-usdc.base.json', 'disable-collateral']
    ] as const;
    for (const [fixture, operation] of cases) {
        const { intent, action } = await loaded(fixture);
        assert.equal(intent.protocol, 'aave');
        assert.equal(intent.adapter, 'aave-v3-base');
        assert.equal(action.operation, operation);
        assert.match(intent.source?.explorerUrl ?? '', /^https:\/\/base\.blockscout\.com\/tx\/0x/);
    }
});

test('resolves Aave max repayment and adds receipt/debt token changes', async () => {
    const transaction = await loadTransaction(resolve(fixtures, 'aave-repay-usdc.base.json'));
    const { intent, action, policy } = await loaded('aave-repay-usdc.base.json');
    assert.equal(action.amount?.mode, 'all');
    const aave = state(intent, exposure(action, { amount: '500000000', variableDebtAfter: '0' }));
    const report = createAuthorizationReport(
        transaction,
        {
            ...policy,
            maximumAmountByToken: { ...policy.maximumAmountByToken, [action.asset.toLowerCase()]: '1000000000' }
        },
        {
            generatedAt: transaction.source!.timestamp,
            nowSeconds: Math.floor(Date.parse(transaction.source!.timestamp) / 1000),
            simulation: simulation(intent),
            aave
        }
    );
    const resolved = report.intent.actions[0];
    assert.equal(resolved?.kind, 'aave');
    if (resolved?.kind !== 'aave') return;
    assert.deepEqual(resolved.amount, { value: '500000000', mode: 'exact' });
    assert.equal(resolved.variableDebtToken, '0x59dca05b6c26dbd64b5381374aAaC5CD05644C28');
    assert.equal(report.intent.expectedBalanceChanges[1]?.category, 'debt');
    assert.equal(report.finalDecision, 'pass');
});

test('requires Aave state and a matching successful simulation', async () => {
    const { intent, policy } = await loaded('aave-supply-usdc.base.json');
    const decision = evaluatePolicy(intent, policy, {
        nowSeconds: 1_791_296_000,
        simulation: { attempted: false, success: false }
    });
    assert.equal(decision.outcome, 'review');
    assert.equal(decision.findings[0]?.code, 'AAVE_STATE_REQUIRED');
});

test('covers Aave policy and preflight rejection paths', async (context) => {
    const { intent, action, policy } = await loaded('aave-supply-usdc.base.json');
    const checkedPolicy = {
        ...policy,
        allowBorrow: true,
        maximumAmountByToken: { ...policy.maximumAmountByToken, [action.asset.toLowerCase()]: '1000000000000' }
    };
    const okState = state(intent, exposure(action));
    await context.test('reserve allowlist', () => {
        const decision = evaluatePolicy(
            intent,
            { ...checkedPolicy, allowedAaveReserves: [] },
            {
                nowSeconds: 1_791_296_000,
                simulation: simulation(intent),
                aave: okState
            }
        );
        assert.ok(decision.findings.some((finding) => finding.code === 'AAVE_RESERVE_NOT_ALLOWED'));
    });
    await context.test('beneficiary allowlist', () => {
        const foreign = '0x1111111111111111111111111111111111111111' as const;
        const alteredAction = { ...action, beneficiary: foreign };
        const altered = { ...intent, actions: [alteredAction] };
        const alteredState = state(altered, exposure(alteredAction));
        const decision = evaluatePolicy(altered, checkedPolicy, {
            nowSeconds: 1_791_296_000,
            simulation: simulation(altered),
            aave: alteredState
        });
        assert.ok(decision.findings.some((finding) => finding.code === 'AAVE_ACCOUNT_MISMATCH'));
    });
    await context.test('minimum health factor', () => {
        const low = exposure(action, {
            accountAfter: { ...exposure(action).accountAfter, healthFactor: '1100000000000000000' }
        });
        const decision = evaluatePolicy(intent, checkedPolicy, {
            nowSeconds: 1_791_296_000,
            simulation: simulation(intent),
            aave: state(intent, low)
        });
        assert.ok(decision.findings.some((finding) => finding.code === 'AAVE_HEALTH_FACTOR_TOO_LOW'));
    });
    const preflightCodes: readonly PolicyReasonCode[] = [
        'AAVE_RESERVE_INACTIVE',
        'AAVE_RESERVE_PAUSED',
        'AAVE_RESERVE_FROZEN',
        'AAVE_BORROWING_DISABLED',
        'AAVE_COLLATERAL_DISABLED',
        'AAVE_SUPPLY_CAP_EXCEEDED',
        'AAVE_BORROW_CAP_EXCEEDED',
        'AAVE_INTEREST_RATE_MODE_NOT_ALLOWED',
        'AAVE_EMODE_NOT_SUPPORTED'
    ];
    for (const code of preflightCodes) {
        await context.test(code, () => {
            const decision = evaluatePolicy(intent, checkedPolicy, {
                nowSeconds: 1_791_296_000,
                simulation: simulation(intent),
                aave: state(intent, exposure(action), {
                    status: 'invalid',
                    exposures: [],
                    errorCode: code,
                    error: code
                })
            });
            assert.ok(decision.findings.some((finding) => finding.code === code));
        });
    }
});
