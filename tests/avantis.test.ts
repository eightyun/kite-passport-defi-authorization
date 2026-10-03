import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { resolve } from 'node:path';
import { encodeAbiParameters, encodeFunctionData, parseAbi, parseAbiParameters, toFunctionSelector, toHex } from 'viem';
import { avantisAbi } from '../src/adapters/avantis.js';
import { decodeTransaction } from '../src/decode.js';
import { loadPolicy, loadTransaction } from '../src/io.js';
import { evaluatePolicy } from '../src/policy.js';
import { preflightAvantis } from '../src/avantis.js';
import type {
    Address,
    AvantisAction,
    AvantisPreflight,
    PolicyReasonCode,
    SimulationResult,
    TransactionEnvelope
} from '../src/domain.js';

const router = '0x44914408af82bC9983bbb330e3578E1105e11d4e' as Address;
const user = '0x1111111111111111111111111111111111111111' as Address;

function transaction(data: `0x${string}`): TransactionEnvelope {
    return { chainId: 8453, from: user, to: router, data, value: '0' };
}

test('decodes supported direct Avantis position operations', () => {
    const trade = {
        trader: user,
        pairIndex: 1n,
        index: 0n,
        initialPosToken: 0n,
        positionSizeUSDC: 10_000_000n,
        openPrice: 86_000n * 10n ** 10n,
        buy: true,
        leverage: 20n * 10n ** 10n,
        tp: 0n,
        sl: 0n,
        timestamp: 0n
    };
    const update = {
        trader: user,
        pairIndex: 1n,
        index: 2n,
        openPrice: trade.openPrice,
        initialPosToken: 2_000_000n,
        leverage: 10n * 10n ** 10n
    };
    const vectors = [
        ['open', encodeFunctionData({ abi: avantisAbi, functionName: 'openTrade', args: [trade, 0, 10n ** 10n] })],
        [
            'close',
            encodeFunctionData({ abi: avantisAbi, functionName: 'closeTradeMarket', args: [1n, 2n, 5_000_000n, 0n] })
        ],
        [
            'increase',
            encodeFunctionData({ abi: avantisAbi, functionName: 'increasePositionSize', args: [update, 10n ** 10n] })
        ],
        ['cancel-limit', encodeFunctionData({ abi: avantisAbi, functionName: 'cancelOpenLimitOrder', args: [1n, 2n] })],
        [
            'update-limit',
            encodeFunctionData({
                abi: avantisAbi,
                functionName: 'updateOpenLimitOrder',
                args: [1n, 2n, trade.openPrice, 10n ** 10n, 0n, 0n]
            })
        ],
        [
            'update-margin',
            encodeFunctionData({ abi: avantisAbi, functionName: 'updateMargin', args: [1n, 2n, 0, 1_000_000n, [], 0] })
        ]
    ] as const;
    for (const [operation, data] of vectors) {
        const intent = decodeTransaction(transaction(data));
        assert.equal(intent.protocol, 'avantis');
        assert.equal(intent.actions[0]?.kind, 'avantis');
        if (intent.actions[0]?.kind === 'avantis') assert.equal(intent.actions[0].operation, operation);
    }
});

test('decodes real signed Avantis open, close and coin-exposure increase vectors', async () => {
    const fixtures = [
        ['avantis-open-usdc.base.json', 'open', 'usdc'],
        ['avantis-close-usdc.base.json', 'close', 'usdc'],
        ['avantis-increase-coin.base.json', 'increase', 'coin']
    ] as const;
    for (const [fixture, operation, sizing] of fixtures) {
        const envelope = await loadTransaction(resolve('fixtures/transactions', fixture));
        const intent = decodeTransaction(envelope);
        const action = intent.actions[0];
        assert.equal(action?.kind, 'avantis');
        if (action?.kind !== 'avantis') continue;
        assert.equal(action.operation, operation);
        assert.equal(action.sizing, sizing);
        assert.equal(action.signedIntent, true);
        assert.match(action.signature ?? '', /^0x[0-9a-f]{130}$/);
        assert.ok(action.deadlineMs && action.nonce);
        assert.ok(intent.expectedBalanceChanges.length > 0);
    }
});

test('independently verifies a real Avantis signature, nonce and delegation', async () => {
    const envelope = await loadTransaction(resolve('fixtures/transactions/avantis-open-usdc.base.json'));
    const intent = decodeTransaction(envelope);
    const server = createServer(async (request, response) => {
        let raw = '';
        for await (const chunk of request) raw += chunk.toString();
        const body = JSON.parse(raw) as { id: number; method: string; params: unknown[] };
        let result: unknown;
        if (body.method === 'eth_chainId') result = toHex(8453);
        else if (body.method === 'eth_getBlockByNumber')
            result = {
                number: toHex(52_063_565),
                hash: `0x${'32'.repeat(32)}`,
                timestamp: toHex(1_790_916_477),
                transactions: [],
                gasLimit: '0x1000000',
                gasUsed: '0x0',
                size: '0x1',
                difficulty: '0x0',
                totalDifficulty: '0x0',
                baseFeePerGas: '0x1'
            };
        else if (body.method === 'eth_call') {
            const call = body.params[0] as { data: `0x${string}` };
            result = call.data.startsWith(toFunctionSelector('nonceBitmap(address,uint256)'))
                ? encodeAbiParameters(parseAbiParameters('uint256'), [0n])
                : encodeAbiParameters(parseAbiParameters('bool,uint256'), [true, 1_796_637_304n]);
        } else throw new Error(`Unexpected RPC method ${body.method}`);
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const bound = server.address();
    assert.ok(bound && typeof bound !== 'string');
    try {
        const state = await preflightAvantis(envelope, intent, `http://127.0.0.1:${bound.port}`, 52_063_565n);
        assert.equal(state.status, 'ready');
        assert.equal(state.checks[0]?.status, 'valid');
        assert.equal(state.checks[0]?.signer, '0xfD4420cb60871833Ef33cD775D486Ac71E7b495C');
        assert.equal(state.checks[0]?.digest, '0xe24122a1c00411b0f49fc4c2c02675ed6740340a2a381233d212091493255970');
        assert.equal(state.checks[0]?.nonceUsed, false);
        assert.equal(state.checks[0]?.delegated, true);
    } finally {
        await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
    }
});

test('fails closed for keeper-only Avantis methods', () => {
    const keeperAbi = parseAbi([
        'function executeMarketOrder(uint256 orderId,bytes[] priceUpdateData,uint8 priceSourcing) payable'
    ]);
    const intent = decodeTransaction(
        transaction(encodeFunctionData({ abi: keeperAbi, functionName: 'executeMarketOrder', args: [1n, [], 0] }))
    );
    assert.equal(intent.actions[0]?.kind, 'unknown');
});

test('covers Avantis policy rejection paths', async (context) => {
    const [envelope, policy] = await Promise.all([
        loadTransaction(resolve('fixtures/transactions/avantis-open-usdc.base.json')),
        loadPolicy(resolve('config/policy.example.json'))
    ]);
    const intent = decodeTransaction(envelope);
    const action = intent.actions[0];
    assert.equal(action?.kind, 'avantis');
    if (action?.kind !== 'avantis' || !intent.transactionFingerprint) return;
    const blockHash = `0x${'12'.repeat(32)}` as const;
    const simulation: SimulationResult = {
        attempted: true,
        success: true,
        transactionFingerprint: intent.transactionFingerprint,
        blockNumber: '1',
        blockHash
    };
    const ready: AvantisPreflight = {
        transactionFingerprint: intent.transactionFingerprint,
        status: 'ready',
        blockNumber: '1',
        blockHash,
        blockTimestamp: 1_790_916_477,
        checks: [
            {
                actionIndex: 0,
                status: 'valid',
                trader: action.trader,
                signer: action.trader,
                nonce: action.nonce!,
                nonceUsed: false,
                delegated: false
            }
        ]
    };
    const expectCode = (
        candidate: AvantisAction,
        code: PolicyReasonCode,
        policyOverride = policy,
        avantis = ready
    ): void => {
        const decision = evaluatePolicy({ ...intent, actions: [candidate] }, policyOverride, {
            nowSeconds: 1_790_916_479,
            simulation,
            avantis
        });
        assert.equal(decision.outcome, 'reject');
        assert.ok(
            decision.findings.some((finding) => finding.code === code),
            `missing ${code}`
        );
    };
    await context.test('pair allowlist', () => expectCode({ ...action, pairIndex: 999 }, 'AVANTIS_PAIR_NOT_ALLOWED'));
    await context.test('opening disabled', () =>
        expectCode(action, 'AVANTIS_OPEN_NOT_ALLOWED', { ...policy, allowAvantisOpen: false })
    );
    await context.test('leverage limit', () =>
        expectCode(action, 'AVANTIS_LEVERAGE_LIMIT_EXCEEDED', { ...policy, maximumAvantisLeverage: '1' })
    );
    await context.test('slippage limit', () =>
        expectCode(action, 'AVANTIS_SLIPPAGE_LIMIT_EXCEEDED', { ...policy, maximumAvantisSlippageP: '1' })
    );
    await context.test('collateral amount limit', () =>
        expectCode(action, 'AMOUNT_LIMIT_EXCEEDED', {
            ...policy,
            maximumAmountByToken: {
                ...policy.maximumAmountByToken,
                ['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913']: '1'
            }
        })
    );
    await context.test('direct trader mismatch', () =>
        expectCode(
            { ...action, signedIntent: false, trader: '0x2222222222222222222222222222222222222222' },
            'AVANTIS_TRADER_MISMATCH'
        )
    );
    await context.test('invalid signature preflight', () =>
        expectCode(action, 'AVANTIS_SIGNATURE_INVALID', policy, {
            ...ready,
            status: 'invalid',
            error: 'Avantis EIP-712 signature is invalid.'
        })
    );
    await context.test('used nonce preflight', () =>
        expectCode(action, 'AVANTIS_NONCE_USED', policy, {
            ...ready,
            status: 'invalid',
            error: 'Avantis unordered nonce is already used.'
        })
    );
    await context.test('invalid delegation preflight', () =>
        expectCode(action, 'AVANTIS_DELEGATION_INVALID', policy, {
            ...ready,
            status: 'invalid',
            error: 'Avantis signer has no active delegation from the trader.'
        })
    );
});
