import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { encodeAbiParameters, parseAbiParameters, toFunctionSelector, toHex } from 'viem';
import { BASE_MOONWELL_COMPTROLLER, BASE_USDC } from '../src/contracts.js';
import type { Hex, TransactionEnvelope } from '../src/domain.js';
import { evaluatePolicy } from '../src/policy.js';
import { decodeTransaction } from '../src/decode.js';
import { loadPolicy } from '../src/io.js';
import { analyzeTransaction, createAuthorizationReport } from '../src/report.js';
import { simulateTransaction, skippedSimulation } from '../src/simulation.js';

const market = '0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22';
const sender = '0x1111111111111111111111111111111111111111';
const borrower = '0x2222222222222222222222222222222222222222';
const maximum = (1n << 256n) - 1n;
const uint = (value: bigint) => encodeAbiParameters(parseAbiParameters('uint256'), [value]);
function transaction(method: string, value = 1n): TransactionEnvelope {
    const payload =
        method === 'enterMarkets'
            ? encodeAbiParameters(parseAbiParameters('address[]'), [[market]])
            : method === 'exitMarket'
              ? encodeAbiParameters(parseAbiParameters('address'), [market])
              : method === 'repayBorrowBehalf'
                ? encodeAbiParameters(parseAbiParameters('address,uint256'), [borrower, value])
                : uint(value);
    const signature =
        method === 'enterMarkets'
            ? 'enterMarkets(address[])'
            : method === 'exitMarket'
              ? 'exitMarket(address)'
              : method === 'repayBorrowBehalf'
                ? 'repayBorrowBehalf(address,uint256)'
                : `${method}(uint256)`;
    return {
        chainId: 8453,
        from: sender,
        to: ['enterMarkets', 'exitMarket'].includes(method) ? BASE_MOONWELL_COMPTROLLER : market,
        value: '0',
        data: `${toFunctionSelector(signature)}${payload.slice(2)}`
    };
}
interface RpcOptions {
    rate?: bigint;
    debt?: bigint;
    balance?: bigint;
    membership?: boolean;
    returnData?: Hex;
    wrongMetadata?: boolean;
}
async function rpc(options: RpcOptions = {}) {
    const calls: { method: string; params: unknown[] }[] = [];
    const server = createServer(async (request, response) => {
        let raw = '';
        for await (const chunk of request) raw += chunk.toString();
        const body = JSON.parse(raw) as {
            id: number;
            method: string;
            params: unknown[];
        };
        calls.push(body);
        let result: unknown;
        if (body.method === 'eth_chainId') result = toHex(8453);
        else if (body.method === 'eth_getBlockByNumber')
            result = {
                number: '0x64',
                hash: `0x${'aa'.repeat(32)}`,
                timestamp: '0x64',
                transactions: [],
                gasLimit: '0x1000000',
                gasUsed: '0x0',
                size: '0x1',
                difficulty: '0x0'
            };
        else if (body.method === 'eth_call') {
            const call = body.params[0] as { data: Hex };
            const selector = call.data.slice(0, 10);
            if (selector === toFunctionSelector('exchangeRateCurrent()'))
                result = uint(options.rate ?? 20_000_000_000_000_000n);
            else if (selector === toFunctionSelector('borrowBalanceCurrent(address)'))
                result = uint(options.debt ?? 500_000n);
            else if (selector === toFunctionSelector('balanceOf(address)'))
                result = uint(options.balance ?? 100_000_000n);
            else if (selector === toFunctionSelector('underlying()'))
                result = encodeAbiParameters(parseAbiParameters('address'), [
                    options.wrongMetadata ? borrower : BASE_USDC
                ]);
            else if (selector === toFunctionSelector('comptroller()'))
                result = encodeAbiParameters(parseAbiParameters('address'), [BASE_MOONWELL_COMPTROLLER]);
            else if (selector === toFunctionSelector('checkMembership(address,address)'))
                result = encodeAbiParameters(parseAbiParameters('bool'), [options.membership ?? true]);
            else if (selector === toFunctionSelector('enterMarkets(address[])'))
                result = options.returnData ?? encodeAbiParameters(parseAbiParameters('uint256[]'), [[0n]]);
            else result = options.returnData ?? uint(0n);
        }
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    return {
        url: `http://127.0.0.1:${address.port}`,
        calls,
        close: () =>
            new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    };
}
async function analyze(tx: TransactionEnvelope, rpcUrl?: string, cap = '1000000') {
    const base = await loadPolicy('config/policy.example.json');
    return analyzeTransaction(
        tx,
        {
            ...base,
            allowBorrow: true,
            allowedRecipients: [borrower],
            maximumAmountByToken: {
                ...base.maximumAmountByToken,
                [BASE_USDC.toLowerCase()]: cap
            }
        },
        {
            generatedAt: '2026-10-01T00:00:00Z',
            nowSeconds: 100,
            ...(rpcUrl ? { rpcUrl } : {})
        }
    );
}

test('Moonwell distinguishes receipt units, underlying units and method-specific all sentinels', () => {
    for (const method of ['mint', 'redeem', 'redeemUnderlying', 'borrow', 'repayBorrow', 'repayBorrowBehalf']) {
        const action = decodeTransaction(transaction(method, maximum)).actions[0];
        assert.equal(action?.kind, 'lending');
        if (action?.kind !== 'lending') return;
        assert.equal(action.amount?.mode, ['mint', 'borrow'].includes(method) ? 'exact' : 'all');
        assert.equal(action.amountAsset?.toLowerCase(), (method === 'redeem' ? market : BASE_USDC).toLowerCase());
    }
});

test('Moonwell compares converted underlying, not receipt units, with policy limits', async (t) => {
    const server = await rpc();
    t.after(server.close);
    const below = await analyze(transaction('redeem', 50_000_000n), server.url);
    assert.equal(below.finalDecision, 'pass');
    assert.equal(below.intent.expectedBalanceChanges[1]?.amount.value, '1000000');
    assert.equal(below.moonwell?.exposures[0]?.receiptBalanceAfter, '50000000');
    assert.equal(below.moonwell?.exposures[0]?.collateralUnderlyingAfter, '1000000');
    const above = await analyze(transaction('redeem', 50_000_001n), server.url, '999999');
    assert.equal(above.finalDecision, 'reject');
    assert.ok(above.policy.findings.some((finding) => finding.code === 'AMOUNT_LIMIT_EXCEEDED'));
    assert.ok(server.calls.filter((call) => call.method === 'eth_call').every((call) => call.params[1] === '0x64'));
});

test('Moonwell also rejects small receipt quantities representing large underlying amounts', async (t) => {
    const server = await rpc({ rate: 2n * 10n ** 18n });
    t.after(server.close);
    const result = await analyze(transaction('redeem', 600_000n), server.url);
    assert.equal(result.finalDecision, 'reject');
    assert.equal(result.moonwell?.exposures[0]?.underlyingAmount, '1200000');
});

test('Moonwell mint and redeemUnderlying follow contract floor rounding', async (t) => {
    const server = await rpc({ rate: 3n * 10n ** 18n });
    t.after(server.close);
    for (const method of ['mint', 'redeemUnderlying']) {
        const result = await analyze(transaction(method, 10n), server.url);
        assert.equal(result.finalDecision, 'pass');
        assert.equal(result.moonwell?.exposures[0]?.receiptAmount, '3');
        assert.equal(result.moonwell?.exposures[0]?.receiptBalanceAfter, method === 'mint' ? '100000003' : '99999997');
    }
    const redeem = await analyze(transaction('redeem', 3n), server.url);
    assert.equal(redeem.moonwell?.exposures[0]?.underlyingAmount, '9');
});

test('Moonwell all withdrawals and repayments resolve balances before applying caps', async (t) => {
    const server = await rpc();
    t.after(server.close);
    for (const method of ['redeem', 'redeemUnderlying']) {
        const result = await analyze(transaction(method, maximum), server.url);
        assert.equal(result.finalDecision, 'reject');
        assert.equal(result.moonwell?.exposures[0]?.underlyingAmount, '2000000');
        assert.equal(result.moonwell?.exposures[0]?.receiptBalanceAfter, '0');
    }
    const repay = await analyze(transaction('repayBorrow', maximum), server.url);
    assert.equal(repay.finalDecision, 'pass');
    assert.equal(repay.moonwell?.exposures[0]?.debtAfter, '0');
    assert.equal(repay.intent.expectedBalanceChanges[0]?.amount.value, '500000');
    const capped = await analyze(transaction('repayBorrow', maximum), server.url, '1');
    assert.equal(capped.finalDecision, 'reject');
});

test('Moonwell rejects excess repayment or redemption instead of clamping amounts', async (t) => {
    const server = await rpc();
    t.after(server.close);
    for (const [method, amount] of [
        ['repayBorrow', 500_001n],
        ['redeem', 100_000_001n]
    ] as const) {
        const result = await analyze(transaction(method, amount), server.url);
        assert.equal(result.finalDecision, 'reject');
        assert.ok(result.policy.findings.some((finding) => finding.code === 'MOONWELL_PRECHECK_FAILED'));
    }
});

test('Moonwell tracks borrow and repayment-on-behalf debt accounts', async (t) => {
    const server = await rpc({ membership: false });
    t.after(server.close);
    const borrow = await analyze(transaction('borrow', 10n), server.url);
    assert.equal(borrow.finalDecision, 'pass');
    assert.equal(borrow.moonwell?.exposures[0]?.debtAfter, '500010');
    assert.equal(borrow.moonwell?.exposures[0]?.collateralEnabledAfter, true);
    const repay = await analyze(transaction('repayBorrowBehalf', 10n), server.url);
    assert.equal(repay.finalDecision, 'pass');
    assert.equal(repay.moonwell?.exposures[0]?.account.toLowerCase(), borrower);
    assert.equal(repay.intent.expectedBalanceChanges[0]?.account, 'sender');
    assert.equal(repay.intent.expectedBalanceChanges[1]?.account.toLowerCase(), borrower);
});

test('Moonwell collateral changes report exposure without claiming token movement', async (t) => {
    for (const method of ['enterMarkets', 'exitMarket']) {
        const server = await rpc({ membership: method !== 'enterMarkets' });
        t.after(server.close);
        const result = await analyze(transaction(method), server.url);
        assert.equal(result.finalDecision, 'pass');
        assert.deepEqual(result.intent.expectedBalanceChanges, []);
        assert.equal(
            result.moonwell?.exposures[0]?.collateralUnderlyingAfter,
            method === 'enterMarkets' ? '2000000' : '0'
        );
    }
});

test('Moonwell requires verified state even when general simulation is optional', async (t) => {
    const tx = transaction('redeem', 1n);
    const offline = await analyze(tx);
    assert.equal(offline.finalDecision, 'review');
    assert.equal(offline.policy.findings[0]?.code, 'MOONWELL_STATE_REQUIRED');
    const server = await rpc({ wrongMetadata: true });
    t.after(server.close);
    const unavailable = await analyze(tx, server.url);
    assert.equal(unavailable.finalDecision, 'review');
});

test('Moonwell rejects state reuse for another transaction or block', async (t) => {
    const server = await rpc();
    t.after(server.close);
    const tx = transaction('redeem', 1n);
    const report = await analyze(tx, server.url);
    assert.ok(report.moonwell);
    const policy = await loadPolicy('config/policy.example.json');
    for (const simulation of [
        { ...report.simulation, blockHash: `0x${'bb'.repeat(32)}` as Hex },
        { ...report.simulation, blockNumber: '101' },
        skippedSimulation()
    ]) {
        assert.equal(
            createAuthorizationReport(tx, policy, {
                generatedAt: report.generatedAt,
                nowSeconds: 100,
                moonwell: report.moonwell,
                simulation
            }).finalDecision,
            'review'
        );
    }
    assert.equal(
        createAuthorizationReport(transaction('redeem', 2n), policy, {
            generatedAt: report.generatedAt,
            nowSeconds: 100,
            moonwell: report.moonwell,
            simulation: report.simulation
        }).finalDecision,
        'review'
    );
});

for (const [method, data] of [
    ['mint', uint(9n)],
    ['exitMarket', uint(9n)],
    ['enterMarkets', encodeAbiParameters(parseAbiParameters('uint256[]'), [[9n]])],
    ['enterMarkets', encodeAbiParameters(parseAbiParameters('uint256[]'), [[]])],
    ['mint', '0x'],
    ['exitMarket', '0x01'],
    ['enterMarkets', '0x']
] as const) {
    test(`Moonwell treats ${method} protocol error/malformed return ${data.slice(0, 16)} as failure`, async (t) => {
        const server = await rpc({ returnData: data });
        t.after(server.close);
        const result = await simulateTransaction(transaction(method), server.url);
        assert.equal(result.success, false);
        assert.match(result.error ?? '', /Moonwell returned/);
    });
}

test('Moonwell collateral markets must be registered and explicitly allowed', async () => {
    const base = await loadPolicy('config/policy.example.json');
    for (const tx of [
        transaction('enterMarkets'),
        {
            ...transaction('enterMarkets'),
            data: `${toFunctionSelector('enterMarkets(address[])')}${encodeAbiParameters(parseAbiParameters('address[]'), [[borrower]]).slice(2)}` as Hex
        }
    ]) {
        const report = createAuthorizationReport(
            tx,
            { ...base, allowedTargets: [BASE_MOONWELL_COMPTROLLER] },
            {
                generatedAt: '2026-10-01T00:00:00Z',
                nowSeconds: 100,
                simulation: skippedSimulation()
            }
        );
        assert.equal(report.finalDecision, 'reject');
        assert.ok(report.policy.findings.some((finding) => finding.code === 'UNAUTHORIZED_TARGET'));
    }
});

test('direct policy callers apply the same Moonwell conversion and caps', async (t) => {
    const server = await rpc();
    t.after(server.close);
    const tx = transaction('redeem', 50_000_000n);
    const report = await analyze(tx, server.url);
    assert.ok(report.moonwell);
    const base = await loadPolicy('config/policy.example.json');
    const policy = {
        ...base,
        maximumAmountByToken: { [BASE_USDC.toLowerCase()]: '999999' }
    };
    const result = evaluatePolicy(decodeTransaction(tx), policy, {
        nowSeconds: 100,
        moonwell: report.moonwell,
        simulation: report.simulation
    });
    assert.equal(result.outcome, 'reject');
    assert.equal(result.findings[0]?.code, 'AMOUNT_LIMIT_EXCEEDED');
});
