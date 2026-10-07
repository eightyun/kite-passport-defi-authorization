import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { access, readFile, readdir } from 'node:fs/promises';
import { loadPolicy, loadTransaction } from '../src/io.js';
import { createAuthorizationReport } from '../src/report.js';
import { skippedSimulation } from '../src/simulation.js';
import type { IntentAnalysis, TransactionEnvelope } from '../src/domain.js';

const fixtureDirectory = resolve('fixtures/transactions');
const policyPath = resolve('config/policy.example.json');

function operationLabels(
    fixture: string,
    transaction: TransactionEnvelope,
    intent: IntentAnalysis
): ReadonlySet<string> {
    const labels = new Set<string>();
    for (const action of intent.actions) {
        if (action.kind === 'swap') {
            if (action.protocolVersion === 'aerodrome') {
                const nativeInput = action.inputAsset === '0x0000000000000000000000000000000000000000';
                const nativeOutput = action.outputAsset === '0x0000000000000000000000000000000000000000';
                labels.add(
                    nativeInput
                        ? 'aerodrome-native-to-token'
                        : nativeOutput
                          ? 'aerodrome-token-to-native'
                          : 'aerodrome-token-to-token'
                );
            } else {
                labels.add(
                    `uniswap-${action.protocolVersion}-${action.mode}-${action.route.length > 1 ? 'multihop' : 'single'}`
                );
                if (action.protocolVersion === 'v4') {
                    const first = action.route[0];
                    const last = action.route.at(-1);
                    if (first?.tokenIn === '0x0000000000000000000000000000000000000000') {
                        labels.add('uniswap-v4-native-input');
                    }
                    if (last?.tokenOut === '0x0000000000000000000000000000000000000000') {
                        labels.add('uniswap-v4-native-output');
                    }
                }
            }
        } else if (action.kind === 'authorization') {
            if (action.permit) {
                labels.add(action.permit.type === 'PermitBatch' ? 'permit2-batch-permit' : 'permit2-single-permit');
            } else if (action.transfers) {
                labels.add(action.transfers.length > 1 ? 'permit2-batch-transfer' : 'permit2-single-transfer');
            }
        } else if (action.kind === 'transfer') {
            const v4 = intent.actions.some(
                (candidate) => candidate.kind === 'swap' && candidate.protocolVersion === 'v4'
            );
            labels.add(
                v4 && ['settle', 'take', 'sweep'].includes(action.operation)
                    ? `uniswap-v4-${action.operation}`
                    : `universal-router-${action.operation.replace('-native', '')}`
            );
        } else if (action.kind === 'morpho') {
            labels.add(`morpho-${action.operation}`);
        } else if (action.kind === 'lending') {
            if (action.operation === 'withdraw') {
                labels.add(
                    transaction.data.startsWith('0xdb006a75')
                        ? 'moonwell-redeem-receipts'
                        : 'moonwell-withdraw-underlying'
                );
            } else if (action.operation === 'repay' && transaction.data.startsWith('0x2608f818')) {
                labels.add('moonwell-repay-on-behalf');
            } else {
                labels.add(`moonwell-${action.operation}`);
            }
        } else if (action.kind === 'avantis') {
            labels.add(
                `avantis-${action.signedIntent ? 'signed-' : ''}${action.operation}-${action.sizing === 'coin' ? 'coin-exposure' : 'usdc'}`
            );
        } else if (action.kind === 'aave') {
            labels.add(`aave-${action.operation}`);
        } else if (action.kind === 'compound') {
            labels.add(`compound-${action.operation}`);
        }
    }
    if (fixture === 'moonwell-redeem-cash-rejection.base.json') {
        labels.add('moonwell-redeem-protocol-rejection');
    }
    if (fixture === 'compound-borrow-base-usdc.base.json') {
        labels.delete('compound-withdraw-base');
        labels.add('compound-borrow-base');
    }
    if (fixture === 'compound-repay-base-usdc.base.json') {
        labels.delete('compound-supply-base');
        labels.add('compound-repay-base');
    }
    return labels;
}

test('decodes a real Uniswap v3 multi-hop exact-input transaction', async () => {
    const transaction = await loadTransaction(resolve(fixtureDirectory, 'uniswap-v3-exact-input.base.json'));
    const policy = await loadPolicy(policyPath);
    const report = createAuthorizationReport(transaction, policy, {
        generatedAt: transaction.source?.timestamp ?? '2026-09-30T17:20:17.000Z',
        nowSeconds: 1_790_788_817,
        simulation: skippedSimulation()
    });
    const swap = report.intent.actions[0];
    assert.equal(report.finalDecision, 'pass');
    assert.equal(report.intent.protocol, 'uniswap');
    assert.equal(swap?.kind, 'swap');
    if (swap?.kind !== 'swap') {
        return;
    }
    assert.equal(swap.protocolVersion, 'v3');
    assert.equal(swap.mode, 'exact-input');
    assert.equal(swap.amountIn.value, '162000000');
    assert.equal(swap.amountOut.value, '8280307828977075455');
    assert.deepEqual(
        swap.route.map((step) => step.fee),
        [100, 3000]
    );
    assert.equal(swap.route[0]?.tokenIn.toLowerCase(), '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
    assert.equal(swap.route[1]?.tokenOut.toLowerCase(), '0xdcf5130274753c8050ab061b1a1dcbf583f5bfd0');
});

test('decodes a real Uniswap v4 swap and its settlement actions', async () => {
    const transaction = await loadTransaction(resolve(fixtureDirectory, 'uniswap-v4-exact-input.base.json'));
    const policy = await loadPolicy(policyPath);
    const report = createAuthorizationReport(transaction, policy, {
        generatedAt: transaction.source?.timestamp ?? '2026-09-30T17:20:45.000Z',
        nowSeconds: 1_790_788_845,
        simulation: skippedSimulation()
    });
    const swap = report.intent.actions[0];
    assert.equal(report.finalDecision, 'pass');
    assert.equal(swap?.kind, 'swap');
    if (swap?.kind !== 'swap') {
        return;
    }
    assert.equal(swap.protocolVersion, 'v4');
    assert.equal(swap.amountIn.value, '334000000000000');
    assert.equal(swap.amountOut.value, '889299');
    assert.equal(swap.recipient, 'sender');
    assert.equal(swap.route[0]?.fee, 375);
    assert.equal(swap.route[0]?.tickSpacing, 4);
    assert.equal(swap.route[0]?.hook, '0x0000000000000000000000000000000000000000');
    assert.deepEqual(
        report.intent.actions.slice(1).map((action) => (action.kind === 'transfer' ? action.operation : action.kind)),
        ['settle', 'take']
    );
});

test('decodes real Moonwell supply and withdraw transactions', async () => {
    const [supply, withdraw, policy] = await Promise.all([
        loadTransaction(resolve(fixtureDirectory, 'moonwell-supply-usdc.base.json')),
        loadTransaction(resolve(fixtureDirectory, 'moonwell-withdraw-usdc.base.json')),
        loadPolicy(policyPath)
    ]);
    const supplyReport = createAuthorizationReport(supply, policy, {
        generatedAt: supply.source?.timestamp ?? '2026-09-30T15:47:43.000Z',
        nowSeconds: 1_790_783_263,
        simulation: skippedSimulation()
    });
    const withdrawReport = createAuthorizationReport(withdraw, policy, {
        generatedAt: withdraw.source?.timestamp ?? '2026-09-30T15:47:49.000Z',
        nowSeconds: 1_790_783_269,
        simulation: skippedSimulation()
    });
    const supplyAction = supplyReport.intent.actions[0];
    const withdrawAction = withdrawReport.intent.actions[0];
    assert.equal(supplyAction?.kind, 'lending');
    assert.equal(withdrawAction?.kind, 'lending');
    if (supplyAction?.kind !== 'lending' || withdrawAction?.kind !== 'lending') {
        return;
    }
    assert.equal(supplyAction.operation, 'supply');
    assert.equal(withdrawAction.operation, 'withdraw');
    assert.equal(supplyAction.amount?.value, '58413');
    assert.equal(withdrawAction.amount?.value, '58413');
    assert.equal(supplyReport.intent.expectedBalanceChanges[1]?.assetSymbol, 'mUSDC');
    assert.equal(withdrawReport.intent.expectedBalanceChanges[1]?.assetSymbol, 'USDC');
});

test('retains verifiable provenance for every real transaction vector', async () => {
    const files = (await readdir(fixtureDirectory)).filter((file) => file.endsWith('.json'));
    for (const file of files) {
        const transaction = await loadTransaction(resolve(fixtureDirectory, file));
        assert.ok(['Base Blockscout', 'BaseScan'].includes(transaction.source?.name ?? ''));
        assert.match(transaction.source?.transactionHash ?? '', /^0x[0-9a-f]{64}$/);
        assert.equal(transaction.source?.observedStatus, 'success');
        assert.match(
            transaction.source?.explorerUrl ?? '',
            /^https:\/\/(?:base\.blockscout\.com|basescan\.org)\/tx\/0x/
        );
    }
});

test('maps every real vector to an auditable operation coverage entry', async () => {
    const coverage = JSON.parse(await readFile(resolve('fixtures/operation-coverage.json'), 'utf8')) as {
        schemaVersion: string;
        chainId: number;
        vectors: readonly {
            fixture: string;
            operations: readonly string[];
            expectedDecision: 'pass' | 'review' | 'reject';
            expectedSimulation: 'pass' | 'reject';
        }[];
        deterministicOnly: readonly { operation: string; test: string; reason: string }[];
    };
    const files = (await readdir(fixtureDirectory)).filter((file) => file.endsWith('.json')).sort();
    const mappedFiles = coverage.vectors.map((vector) => vector.fixture).sort();
    assert.equal(coverage.schemaVersion, '1.0');
    assert.equal(coverage.chainId, 8453);
    assert.deepEqual(mappedFiles, files);

    const coveredOperations = new Set(coverage.vectors.flatMap((vector) => vector.operations));
    const requiredOperations = [
        'uniswap-v2-exact-input-single',
        'uniswap-v2-exact-output-single',
        'uniswap-v3-exact-input-single',
        'uniswap-v3-exact-input-multihop',
        'uniswap-v3-exact-output-single',
        'uniswap-v3-exact-output-multihop',
        'uniswap-v4-exact-input-single',
        'uniswap-v4-exact-input-multihop',
        'uniswap-v4-exact-output-single',
        'uniswap-v4-exact-output-multihop',
        'uniswap-v4-native-input',
        'uniswap-v4-native-output',
        'permit2-single-permit',
        'permit2-single-transfer',
        'universal-router-wrap',
        'universal-router-unwrap',
        'universal-router-sweep',
        'universal-router-transfer',
        'aerodrome-token-to-token',
        'aerodrome-native-to-token',
        'aerodrome-token-to-native',
        'moonwell-supply',
        'moonwell-withdraw-underlying',
        'moonwell-redeem-receipts',
        'moonwell-borrow',
        'moonwell-repay',
        'moonwell-repay-on-behalf',
        'moonwell-enable-collateral',
        'moonwell-disable-collateral',
        'morpho-supply',
        'morpho-withdraw',
        'morpho-borrow',
        'morpho-repay',
        'morpho-supply-collateral',
        'morpho-withdraw-collateral',
        'avantis-signed-open-usdc',
        'avantis-signed-close-usdc',
        'avantis-signed-increase-coin-exposure',
        'aave-supply',
        'aave-withdraw',
        'aave-borrow',
        'aave-repay',
        'aave-enable-collateral',
        'aave-disable-collateral',
        'compound-supply-base',
        'compound-withdraw-base',
        'compound-borrow-base',
        'compound-repay-base',
        'compound-supply-collateral',
        'compound-withdraw-collateral',
        'compound-allow-manager'
    ];
    for (const operation of requiredOperations) {
        assert.ok(coveredOperations.has(operation), `${operation} lacks a real transaction vector`);
    }

    const policy = await loadPolicy(policyPath);
    for (const vector of coverage.vectors) {
        const transaction = await loadTransaction(resolve(fixtureDirectory, vector.fixture));
        const report = createAuthorizationReport(transaction, policy, {
            generatedAt: transaction.source?.timestamp ?? '2026-10-01T00:00:00.000Z',
            nowSeconds: Math.floor(Date.parse(transaction.source?.timestamp ?? '2026-10-01T00:00:00.000Z') / 1000),
            simulation: skippedSimulation()
        });
        assert.ok(
            report.intent.actions.every((action) => action.kind !== 'unknown'),
            vector.fixture
        );
        const labels = operationLabels(vector.fixture, transaction, report.intent);
        for (const operation of vector.operations) {
            assert.ok(labels.has(operation), `${vector.fixture} does not decode ${operation}`);
        }
    }

    for (const entry of coverage.deterministicOnly) {
        assert.ok(entry.reason.length > 0);
        await access(resolve(entry.test));
    }
});
