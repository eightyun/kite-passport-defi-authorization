import assert from 'node:assert/strict';
import test from 'node:test';
import { concatHex, encodeAbiParameters, encodeFunctionData, parseAbi, parseAbiParameters, toHex } from 'viem';
import {
    BASE_MOONWELL_COMPTROLLER,
    BASE_MOONWELL_MARKETS,
    BASE_UNISWAP_UNIVERSAL_ROUTER,
    BASE_USDBC,
    BASE_USDC,
    BASE_WETH,
    ZERO_ADDRESS
} from '../src/contracts.js';
import { decodeTransaction } from '../src/decode.js';
import type { Address, Hex, TransactionEnvelope } from '../src/domain.js';

const sender = '0x2222222222222222222222222222222222222222' as Address;

function universalRouterTransaction(command: Hex, input: Hex): TransactionEnvelope {
    return {
        chainId: 8453,
        from: sender,
        to: BASE_UNISWAP_UNIVERSAL_ROUTER,
        value: '0',
        data: encodeFunctionData({
            abi: parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable']),
            functionName: 'execute',
            args: [command, [input], 2_000_000_000n]
        })
    };
}

test('decodes Uniswap v2 exact-output amounts in semantic order', () => {
    const input = encodeAbiParameters(
        parseAbiParameters(
            'address recipient, uint256 amountOut, uint256 amountInMaximum, address[] path, bool payerIsUser'
        ),
        [sender, 100n, 200n, [BASE_USDC, BASE_WETH], true]
    );
    const analysis = decodeTransaction(universalRouterTransaction('0x09', input));
    const swap = analysis.actions[0];
    assert.equal(swap?.kind, 'swap');
    if (swap?.kind !== 'swap') {
        return;
    }
    assert.equal(swap.protocolVersion, 'v2');
    assert.equal(swap.mode, 'exact-output');
    assert.deepEqual(swap.amountIn, { value: '200', mode: 'maximum' });
    assert.deepEqual(swap.amountOut, { value: '100', mode: 'exact' });
});

test('reverses a Uniswap v3 exact-output path into execution order', () => {
    const reversedPath = concatHex([BASE_WETH, toHex(3000, { size: 3 }), BASE_USDC]);
    const input = encodeAbiParameters(
        parseAbiParameters(
            'address recipient, uint256 amountOut, uint256 amountInMaximum, bytes path, bool payerIsUser'
        ),
        [sender, 100n, 200n, reversedPath, true]
    );
    const analysis = decodeTransaction(universalRouterTransaction('0x01', input));
    const swap = analysis.actions[0];
    assert.equal(swap?.kind, 'swap');
    if (swap?.kind !== 'swap') {
        return;
    }
    assert.equal(swap.route[0]?.tokenIn, BASE_USDC);
    assert.equal(swap.route[0]?.tokenOut, BASE_WETH);
    assert.equal(swap.route[0]?.fee, 3000);
    assert.deepEqual(swap.amountIn, { value: '200', mode: 'maximum' });
    assert.deepEqual(swap.amountOut, { value: '100', mode: 'exact' });
});

test('reports Universal Router wrap, sweep and transfer balance bounds', () => {
    const wrapInput = encodeAbiParameters(parseAbiParameters('address recipient, uint256 amount'), [sender, 100n]);
    const wrap = decodeTransaction(universalRouterTransaction('0x0b', wrapInput));
    assert.deepEqual(wrap.actions[0], {
        kind: 'transfer',
        index: 0,
        operation: 'wrap-native',
        recipient: 'sender',
        amount: { value: '100', mode: 'exact' }
    });
    assert.deepEqual(
        wrap.expectedBalanceChanges.map((change) => [change.account, change.asset, change.direction, change.amount]),
        [
            ['router', ZERO_ADDRESS, 'debit', { value: '100', mode: 'exact' }],
            ['sender', BASE_WETH, 'credit', { value: '100', mode: 'exact' }]
        ]
    );

    const sweepInput = encodeAbiParameters(
        parseAbiParameters('address asset, address recipient, uint256 amountMinimum'),
        [BASE_USDC, sender, 75n]
    );
    const sweep = decodeTransaction(universalRouterTransaction('0x04', sweepInput));
    assert.deepEqual(
        sweep.expectedBalanceChanges.map((change) => [change.account, change.direction, change.amount]),
        [
            ['router', 'debit', { value: '75', mode: 'minimum' }],
            ['sender', 'credit', { value: '75', mode: 'minimum' }]
        ]
    );

    const transferInput = encodeAbiParameters(parseAbiParameters('address asset, address recipient, uint256 amount'), [
        BASE_USDC,
        sender,
        50n
    ]);
    const transfer = decodeTransaction(universalRouterTransaction('0x05', transferInput));
    assert.deepEqual(
        transfer.expectedBalanceChanges.map((change) => [change.account, change.direction, change.amount]),
        [
            ['router', 'debit', { value: '50', mode: 'exact' }],
            ['sender', 'credit', { value: '50', mode: 'exact' }]
        ]
    );
});

test('reports Uniswap v4 settlement and take balance bounds', () => {
    const settle = encodeAbiParameters(parseAbiParameters('address asset, uint256 amount, bool payerIsUser'), [
        BASE_USDC,
        100n,
        true
    ]);
    const take = encodeAbiParameters(parseAbiParameters('address asset, address recipient, uint256 amount'), [
        BASE_WETH,
        sender,
        25n
    ]);
    const v4Input = encodeAbiParameters(parseAbiParameters('bytes actions, bytes[] params'), [
        '0x0b0e',
        [settle, take]
    ]);
    const analysis = decodeTransaction(universalRouterTransaction('0x10', v4Input));
    assert.deepEqual(
        analysis.expectedBalanceChanges.map((change) => [change.account, change.asset, change.direction]),
        [
            ['sender', BASE_USDC, 'debit'],
            ['settlement', BASE_USDC, 'credit'],
            ['settlement', BASE_WETH, 'debit'],
            ['sender', BASE_WETH, 'credit']
        ]
    );
});

test('decodes Uniswap v4 wrap and unwrap actions', () => {
    const wrap = encodeAbiParameters(parseAbiParameters('uint256 amount'), [100n]);
    const unwrap = encodeAbiParameters(parseAbiParameters('uint256 amount'), [50n]);
    const v4Input = encodeAbiParameters(parseAbiParameters('bytes actions, bytes[] params'), [
        '0x1516',
        [wrap, unwrap]
    ]);
    const analysis = decodeTransaction(universalRouterTransaction('0x10', v4Input));
    assert.deepEqual(
        analysis.actions.map((action) => (action.kind === 'transfer' ? action.operation : action.kind)),
        ['wrap-native', 'unwrap-native']
    );
    assert.deepEqual(
        analysis.expectedBalanceChanges.map((change) => [change.account, change.asset, change.direction]),
        [
            ['settlement', ZERO_ADDRESS, 'debit'],
            ['settlement', BASE_WETH, 'credit'],
            ['settlement', BASE_WETH, 'debit'],
            ['settlement', ZERO_ADDRESS, 'credit']
        ]
    );
});

test('decodes a vanilla Uniswap v4 exact-output single-pool swap', () => {
    const swapParams = encodeAbiParameters(
        parseAbiParameters(
            '((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 amountOut, uint128 amountInMaximum, uint256 minHopPriceX36, bytes hookData) params'
        ),
        [
            {
                poolKey: {
                    currency0: ZERO_ADDRESS,
                    currency1: BASE_USDBC,
                    fee: 500,
                    tickSpacing: 10,
                    hooks: ZERO_ADDRESS
                },
                zeroForOne: false,
                amountOut: 123n,
                amountInMaximum: 456n,
                minHopPriceX36: 0n,
                hookData: '0x'
            }
        ]
    );
    const v4Input = encodeAbiParameters(parseAbiParameters('bytes actions, bytes[] params'), ['0x08', [swapParams]]);
    const analysis = decodeTransaction(universalRouterTransaction('0x10', v4Input));
    const swap = analysis.actions[0];
    assert.equal(swap?.kind, 'swap');
    if (swap?.kind !== 'swap') {
        return;
    }
    assert.equal(swap.protocolVersion, 'v4');
    assert.equal(swap.route[0]?.tokenIn.toLowerCase(), BASE_USDBC.toLowerCase());
    assert.equal(swap.route[0]?.tokenOut, ZERO_ADDRESS);
    assert.deepEqual(swap.amountIn, { value: '456', mode: 'maximum' });
    assert.deepEqual(swap.amountOut, { value: '123', mode: 'exact' });
});

function moonwellTransaction(target: Address, data: Hex): TransactionEnvelope {
    return { chainId: 8453, from: sender, to: target, value: '0', data };
}

test('decodes Moonwell borrow and repay-on-behalf operations', () => {
    const market = BASE_MOONWELL_MARKETS[0]!;
    const borrowData = encodeFunctionData({
        abi: parseAbi(['function borrow(uint256 amount)']),
        functionName: 'borrow',
        args: [500n]
    });
    const repayData = encodeFunctionData({
        abi: parseAbi(['function repayBorrowBehalf(address borrower, uint256 amount)']),
        functionName: 'repayBorrowBehalf',
        args: [sender, 300n]
    });
    const borrow = decodeTransaction(moonwellTransaction(market.market, borrowData)).actions[0];
    const repay = decodeTransaction(moonwellTransaction(market.market, repayData)).actions[0];
    assert.equal(borrow?.kind, 'lending');
    assert.equal(repay?.kind, 'lending');
    if (borrow?.kind !== 'lending' || repay?.kind !== 'lending') {
        return;
    }
    assert.equal(borrow.operation, 'borrow');
    assert.equal(borrow.amount?.value, '500');
    assert.equal(repay.operation, 'repay');
    assert.equal(repay.amount?.value, '300');
    assert.equal(repay.beneficiary, sender);
});

test('decodes Moonwell collateral enablement for every requested market', () => {
    const markets = BASE_MOONWELL_MARKETS.map((market) => market.market);
    const data = encodeFunctionData({
        abi: parseAbi(['function enterMarkets(address[] markets) returns (uint256[])']),
        functionName: 'enterMarkets',
        args: [markets]
    });
    const analysis = decodeTransaction(moonwellTransaction(BASE_MOONWELL_COMPTROLLER, data));
    assert.equal(analysis.actions.length, markets.length);
    assert.ok(
        analysis.actions.every((action) => action.kind === 'lending' && action.operation === 'enable-collateral')
    );
});

test('returns a rejectable intent for an unregistered target', () => {
    const target = '0x1111111111111111111111111111111111111111' as Address;
    const analysis = decodeTransaction(
        moonwellTransaction(target, '0x123456780000000000000000000000000000000000000000000000000000000000000001')
    );
    assert.equal(analysis.protocol, 'unknown');
    assert.equal(analysis.actions[0]?.kind, 'unknown');
});

test('marks Universal Router allow-revert commands as unsupported', () => {
    const input = encodeAbiParameters(
        parseAbiParameters(
            'address recipient, uint256 amountIn, uint256 amountOutMinimum, address[] path, bool payerIsUser'
        ),
        [sender, 100n, 1n, [BASE_USDC, BASE_WETH], true]
    );
    const analysis = decodeTransaction(universalRouterTransaction('0x88', input));
    const action = analysis.actions[0];
    assert.equal(action?.kind, 'unknown');
    if (action?.kind === 'unknown') {
        assert.match(action.reason, /allow-revert/);
    }
});

test('decodes Universal Router sub-plans and assigns unique flattened action indexes', () => {
    const swapInput = encodeAbiParameters(
        parseAbiParameters(
            'address recipient, uint256 amountIn, uint256 amountOutMinimum, address[] path, bool payerIsUser'
        ),
        [sender, 100n, 1n, [BASE_USDC, BASE_WETH], true]
    );
    const subPlan = encodeAbiParameters(parseAbiParameters('bytes commands, bytes[] inputs'), [
        '0x0808',
        [swapInput, swapInput]
    ]);
    const analysis = decodeTransaction(universalRouterTransaction('0x21', subPlan));
    assert.deepEqual(
        analysis.actions.map((action) => [action.kind, action.index]),
        [
            ['swap', 0],
            ['swap', 1]
        ]
    );
});

test('rejects allow-revert commands inside Universal Router sub-plans', () => {
    const swapInput = encodeAbiParameters(
        parseAbiParameters(
            'address recipient, uint256 amountIn, uint256 amountOutMinimum, address[] path, bool payerIsUser'
        ),
        [sender, 100n, 1n, [BASE_USDC, BASE_WETH], true]
    );
    const subPlan = encodeAbiParameters(parseAbiParameters('bytes commands, bytes[] inputs'), ['0x88', [swapInput]]);
    const action = decodeTransaction(universalRouterTransaction('0x21', subPlan)).actions[0];
    assert.equal(action?.kind, 'unknown');
    if (action?.kind === 'unknown') assert.match(action.reason, /allow-revert/);
});

test('fails closed when Universal Router sub-plans exceed the recursion limit', () => {
    let input = encodeAbiParameters(parseAbiParameters('bytes commands, bytes[] inputs'), ['0x', []]);
    for (let depth = 0; depth < 5; depth += 1) {
        input = encodeAbiParameters(parseAbiParameters('bytes commands, bytes[] inputs'), ['0x21', [input]]);
    }
    const action = decodeTransaction(universalRouterTransaction('0x21', input)).actions[0];
    assert.equal(action?.kind, 'unknown');
    if (action?.kind === 'unknown') assert.match(action.reason, /depth exceeds/);
});
