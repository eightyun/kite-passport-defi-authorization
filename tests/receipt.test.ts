import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createAuthorizationReport } from '../src/report.js';
import { ANALYZER_VERSION, verifyAuthorizationReceipt } from '../src/receipt.js';
import { loadPolicy, loadTransaction } from '../src/io.js';
import type { AuthorizationReport } from '../src/domain.js';
import { transactionFingerprint } from '../src/permit2.js';

async function fixture(): Promise<{
    report: AuthorizationReport;
    policy: Awaited<ReturnType<typeof loadPolicy>>;
}> {
    const [transaction, policy] = await Promise.all([
        loadTransaction(resolve('fixtures/transactions/uniswap-v4-exact-input.base.json')),
        loadPolicy(resolve('config/policy.example.json'))
    ]);
    const report = createAuthorizationReport(transaction, policy, {
        generatedAt: '2026-10-07T00:00:00.000Z',
        nowSeconds: 1_791_331_200,
        simulation: {
            attempted: true,
            success: true,
            blockNumber: '12345678',
            blockHash: `0x${'12'.repeat(32)}`,
            transactionFingerprint: transactionFingerprint(transaction),
            returnData: '0x'
        }
    });
    return { report, policy };
}

test('emits a policy-bound, exact-block authorization receipt', async () => {
    const { report, policy } = await fixture();
    const result = verifyAuthorizationReceipt(report, policy, 12_345_678n);
    assert.equal(result.valid, true);
    assert.deepEqual(result.findings, []);
    assert.equal(result.validFromBlock, '12345678');
    assert.equal(result.validUntilBlock, '12345678');
    assert.equal(report.receipt?.verificationBlockHash, report.simulation.blockHash);
});

test('detects report, policy and block mismatches', async () => {
    const { report, policy } = await fixture();
    const tampered = structuredClone(report) as unknown as { transaction: { value: string } };
    tampered.transaction.value = '1';
    assert.equal(verifyAuthorizationReceipt(tampered, policy).valid, false);
    assert.equal(verifyAuthorizationReceipt(report, { ...policy, maximumNativeValue: '1' }).valid, false);
    assert.equal(verifyAuthorizationReceipt(report, policy, 12_345_679n).valid, false);
    assert.equal(
        verifyAuthorizationReceipt(
            {
                ...report,
                transaction: { ...report.transaction, value: 'not-an-integer' }
            },
            policy
        ).valid,
        false
    );
});

test('keeps the analyzer version synchronized with package metadata', async () => {
    const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as { version: string };
    assert.equal(ANALYZER_VERSION, packageJson.version);
});

test('verifies every committed fixed-block evidence receipt', async () => {
    const policy = await loadPolicy(resolve('config/policy.example.json'));
    const directory = resolve('evidence/reports');
    const files = (await readdir(directory)).filter((file) => file.endsWith('.report.json'));
    assert.ok(files.length > 0);
    for (const file of files) {
        const report = JSON.parse(await readFile(resolve(directory, file), 'utf8')) as AuthorizationReport;
        assert.ok(report.simulation.blockNumber, `${file} lacks a fixed simulation block`);
        const result = verifyAuthorizationReceipt(report, policy, BigInt(report.simulation.blockNumber));
        assert.equal(result.valid, true, `${file}: ${result.findings.join('; ')}`);
    }
});
