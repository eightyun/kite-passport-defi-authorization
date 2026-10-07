import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { encodeFunctionData } from 'viem';
import { compoundCometAbi, decodeCompoundTransaction } from '../src/adapters/compound.js';
import { decodeTransaction } from '../src/decode.js';
import { loadPolicy, loadTransaction } from '../src/io.js';
import { createAuthorizationReport } from '../src/report.js';
import { evaluatePolicy } from '../src/policy.js';
import type {
    CompoundAction,
    CompoundExposure,
    CompoundPreflight,
    IntentAnalysis,
    PolicyConfig,
    PolicyReasonCode,
    SimulationResult,
    TransactionEnvelope
} from '../src/domain.js';

const fixtures = resolve('fixtures/transactions');
const blockHash = `0x${'22'.repeat(32)}` as const;

function simulation(intent: IntentAnalysis): SimulationResult {
    return {
        attempted: true,
        success: true,
        blockNumber: '100',
        blockHash,
        transactionFingerprint: intent.transactionFingerprint!
    };
}

function exposure(action: CompoundAction, overrides: Partial<CompoundExposure> = {}): CompoundExposure {
    return {
        actionIndex: action.index,
        operation: action.operation,
        method: action.method,
        market: action.market,
        baseToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        ...(action.asset ? { asset: action.asset } : {}),
        account: action.account,
        source: action.source,
        recipient: action.recipient ?? action.account,
        amount: action.amount?.mode === 'all' ? '500000000' : (action.amount?.value ?? '0'),
        baseSupplyBefore: '1000000000',
        baseSupplyAfter: '1010000000',
        baseBorrowBefore: '0',
        baseBorrowAfter: '0',
        collateralBalanceBefore: '2000000000000000000',
        collateralBalanceAfter: '2000000000000000000',
        totalCollateralBefore: '1000000000000000000000',
        totalCollateralAfter: '1000000000000000000000',
        collateralSupplyCap: '11000000000000000000000',
        borrowCapacityBaseBefore: '3000000000',
        borrowCapacityBaseAfter: '3000000000',
        liquidationCapacityBaseBefore: '3500000000',
        liquidationCapacityBaseAfter: '3500000000',
        baseBorrowMinimum: '1000000',
        permissionBefore: true,
        ...overrides
    };
}

function state(
    intent: IntentAnalysis,
    entry: CompoundExposure,
    overrides: Partial<CompoundPreflight> = {}
): CompoundPreflight {
    return {
        transactionFingerprint: intent.transactionFingerprint!,
        status: 'ready',
        blockNumber: '100',
        blockHash,
        blockTimestamp: 1_791_344_000,
        exposures: [entry],
        ...overrides
    };
}

async function loaded(
    name: string
): Promise<{ intent: IntentAnalysis; action: CompoundAction; policy: PolicyConfig; transaction: TransactionEnvelope }> {
    const transaction = await loadTransaction(resolve(fixtures, name));
    const intent = decodeTransaction(transaction);
    const action = intent.actions[0];
    assert.equal(action?.kind, 'compound');
    if (action?.kind !== 'compound') throw new Error('Expected Compound action');
    return { intent, action, policy: await loadPolicy('config/policy.example.json'), transaction };
}

test('decodes seven real Base Compound III transaction vectors', async () => {
    const cases = [
        ['compound-supply-base-usdc.base.json', 'supply-base', 'supply'],
        ['compound-withdraw-base-usdc.base.json', 'withdraw-base', 'withdraw'],
        ['compound-borrow-base-usdc.base.json', 'withdraw-base', 'withdraw'],
        ['compound-repay-base-usdc.base.json', 'supply-base', 'supply'],
        ['compound-supply-collateral-cbbtc.base.json', 'supply-collateral', 'supply'],
        ['compound-withdraw-collateral-weth.base.json', 'withdraw-collateral', 'withdraw'],
        ['compound-allow-manager.base.json', 'allow-manager', 'allow']
    ] as const;
    for (const [fixture, operation, method] of cases) {
        const { intent, action } = await loaded(fixture);
        assert.equal(intent.protocol, 'compound');
        assert.equal(intent.adapter, 'compound-v3-base-usdc');
        assert.equal(action.operation, operation);
        assert.equal(action.method, method);
        assert.match(intent.source?.explorerUrl ?? '', /^https:\/\/basescan\.org\/tx\/0x/);
    }
});

test('decodes Compound III supplyTo, supplyFrom, withdrawTo, withdrawFrom and allowBySig', () => {
    const sender = '0x1111111111111111111111111111111111111111' as const;
    const other = '0x2222222222222222222222222222222222222222' as const;
    const asset = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;
    const target = '0xb125E6687d4313864e53df431d5425969c15Eb2F' as const;
    const calls = [
        ['supplyTo', [other, asset, 1n]],
        ['supplyFrom', [other, sender, asset, 2n]],
        ['withdrawTo', [other, asset, 3n]],
        ['withdrawFrom', [other, sender, asset, 4n]],
        ['allowBySig', [sender, other, true, 0n, 2_000_000_000n, 27, `0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`]]
    ] as const;
    for (const [functionName, args] of calls) {
        const transaction: TransactionEnvelope = {
            chainId: 8453,
            from: sender,
            to: target,
            data: encodeFunctionData({ abi: compoundCometAbi, functionName, args } as never),
            value: '0'
        };
        const intent = decodeCompoundTransaction(transaction);
        const action = intent.actions[0];
        assert.equal(action?.kind, 'compound');
        if (action?.kind === 'compound') assert.equal(action.method, functionName);
    }
});

test('resolves Compound base supply and withdrawal into repay and borrow effects', async () => {
    const repayCase = await loaded('compound-repay-base-usdc.base.json');
    const repayExposure = exposure(repayCase.action, {
        operation: 'repay-base',
        amount: '308716839',
        baseSupplyBefore: '0',
        baseSupplyAfter: '0',
        baseBorrowBefore: '105626138216',
        baseBorrowAfter: '105317421377'
    });
    const repayReport = createAuthorizationReport(repayCase.transaction, repayCase.policy, {
        generatedAt: repayCase.transaction.source!.timestamp,
        nowSeconds: 1_791_344_000,
        simulation: simulation(repayCase.intent),
        compound: state(repayCase.intent, repayExposure)
    });
    assert.equal((repayReport.intent.actions[0] as CompoundAction).operation, 'repay-base');
    assert.equal(
        repayReport.intent.expectedBalanceChanges.some((change) => change.category === 'debt'),
        true
    );

    const borrowCase = await loaded('compound-borrow-base-usdc.base.json');
    const borrowExposure = exposure(borrowCase.action, {
        operation: 'borrow-base',
        amount: '120000000',
        baseSupplyBefore: '0',
        baseSupplyAfter: '0',
        baseBorrowBefore: '444445114',
        baseBorrowAfter: '564445114'
    });
    const borrowReport = createAuthorizationReport(borrowCase.transaction, borrowCase.policy, {
        generatedAt: borrowCase.transaction.source!.timestamp,
        nowSeconds: 1_791_344_000,
        simulation: simulation(borrowCase.intent),
        compound: state(borrowCase.intent, borrowExposure)
    });
    assert.equal((borrowReport.intent.actions[0] as CompoundAction).operation, 'borrow-base');
    assert.ok(borrowReport.policy.findings.some((finding) => finding.code === 'BORROW_NOT_ALLOWED'));
});

test('requires Compound fixed-block state and matching simulation', async () => {
    const { intent, policy } = await loaded('compound-supply-base-usdc.base.json');
    const decision = evaluatePolicy(intent, policy, {
        nowSeconds: 1_791_344_000,
        simulation: { attempted: false, success: false }
    });
    assert.equal(decision.outcome, 'review');
    assert.equal(decision.findings[0]?.code, 'COMPOUND_STATE_REQUIRED');
});

test('covers Compound policy and preflight rejection paths', async (context) => {
    const { intent, action, policy } = await loaded('compound-supply-collateral-cbbtc.base.json');
    const okState = state(intent, exposure(action));
    await context.test('asset allowlist', () => {
        const decision = evaluatePolicy(
            intent,
            { ...policy, allowedCompoundAssets: [] },
            {
                nowSeconds: 1_791_344_000,
                simulation: simulation(intent),
                compound: okState
            }
        );
        assert.ok(decision.findings.some((finding) => finding.code === 'COMPOUND_ASSET_NOT_ALLOWED'));
    });
    const allowCase = await loaded('compound-allow-manager.base.json');
    await context.test('manager allowlist', () => {
        const decision = evaluatePolicy(
            allowCase.intent,
            { ...policy, allowedCompoundManagers: [] },
            {
                nowSeconds: 1_791_344_000,
                simulation: simulation(allowCase.intent),
                compound: state(allowCase.intent, exposure(allowCase.action))
            }
        );
        assert.ok(decision.findings.some((finding) => finding.code === 'COMPOUND_MANAGER_NOT_ALLOWED'));
    });
    const codes: readonly PolicyReasonCode[] = [
        'COMPOUND_MARKET_MISMATCH',
        'COMPOUND_SUPPLY_PAUSED',
        'COMPOUND_WITHDRAW_PAUSED',
        'COMPOUND_SUPPLY_CAP_EXCEEDED',
        'COMPOUND_OPERATOR_NOT_ALLOWED',
        'COMPOUND_SIGNATURE_INVALID',
        'COMPOUND_NONCE_MISMATCH',
        'COMPOUND_SIGNATURE_EXPIRED',
        'COMPOUND_BORROW_TOO_SMALL',
        'COMPOUND_NOT_COLLATERALIZED'
    ];
    for (const code of codes) {
        await context.test(code, () => {
            const decision = evaluatePolicy(intent, policy, {
                nowSeconds: 1_791_344_000,
                simulation: simulation(intent),
                compound: state(intent, exposure(action), {
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
