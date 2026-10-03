import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { encodeAbiParameters, encodeFunctionData, parseAbiParameters, toFunctionSelector } from 'viem';
import { morphoAbi } from '../src/adapters/morpho.js';
import { aerodromeAbi } from '../src/adapters/aerodrome.js';
import { decodeTransaction } from '../src/decode.js';
import type { Address, Hex, MorphoPreflight, SimulationResult, TransactionEnvelope } from '../src/domain.js';
import { loadPolicy, loadTransaction } from '../src/io.js';
import { resolveMorpho } from '../src/morpho.js';
import { evaluatePolicy } from '../src/policy.js';

const fixtures = resolve('fixtures/transactions');

test('decodes a real Aerodrome route with factory and slippage bounds', async () => {
    const transaction = await loadTransaction(resolve(fixtures, 'aerodrome-swap-usdc-aero.base.json'));
    const intent = decodeTransaction(transaction);
    const action = intent.actions[0];
    assert.equal(intent.protocol, 'aerodrome');
    assert.equal(action?.kind, 'swap');
    if (action?.kind !== 'swap') return;
    assert.equal(action.protocolVersion, 'aerodrome');
    assert.equal(action.amountIn.value, '999999985');
    assert.equal(action.amountOut.value, '1279263363756527085781');
    assert.equal(action.route[0]?.stable, false);
    assert.equal(action.route[0]?.factory?.toLowerCase(), '0x420dd381b31aef6683db6b902084cb0ffece40da');
});

test('rejects Aerodrome unsafe swaps and unapproved factories', async () => {
    const [transaction, policy] = await Promise.all([
        loadTransaction(resolve(fixtures, 'aerodrome-swap-usdc-aero.base.json')),
        loadPolicy(resolve('config/policy.example.json'))
    ]);
    const unsafe = decodeTransaction({
        ...transaction,
        data: `${toFunctionSelector('UNSAFE_swapExactTokensForTokens(uint256,uint256,(address,address,bool,address)[],address,uint256)')}${transaction.data.slice(10)}` as Hex
    });
    assert.equal(unsafe.actions[0]?.kind, 'unknown');
    const intent = decodeTransaction(transaction);
    const action = intent.actions[0];
    assert.equal(action?.kind, 'swap');
    if (action?.kind !== 'swap') return;
    const decision = evaluatePolicy(
        {
            ...intent,
            actions: [
                { ...action, route: [{ ...action.route[0]!, factory: '0x1111111111111111111111111111111111111111' }] }
            ]
        },
        policy,
        {
            nowSeconds: 1_790_873_559,
            simulation: { attempted: true, success: true }
        }
    );
    assert.ok(decision.findings.some((finding) => finding.code === 'AERODROME_FACTORY_NOT_ALLOWED'));
});

test('normalizes Aerodrome native input and output routes', () => {
    const route = [
        {
            from: '0x4200000000000000000000000000000000000006',
            to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
            stable: false,
            factory: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da'
        }
    ] as const;
    const nativeInput = decodeTransaction({
        ...aerodromeTransaction(
            encodeFunctionData({
                abi: aerodromeAbi,
                functionName: 'swapExactETHForTokens',
                args: [1n, route, '0x0000000000000000000000000000000000000000', 2_000_000_000n]
            })
        ),
        value: '2'
    });
    const inputAction = nativeInput.actions[0];
    assert.equal(inputAction?.kind, 'swap');
    if (inputAction?.kind === 'swap') {
        assert.equal(inputAction.inputAsset, '0x0000000000000000000000000000000000000000');
        assert.equal(inputAction.amountIn.value, '2');
        assert.equal(inputAction.recipient, user);
    }
    const nativeOutput = decodeTransaction(
        aerodromeTransaction(
            encodeFunctionData({
                abi: aerodromeAbi,
                functionName: 'swapExactTokensForETH',
                args: [2n, 1n, [{ ...route[0], from: route[0].to, to: route[0].from }], user, 2_000_000_000n]
            })
        )
    );
    const outputAction = nativeOutput.actions[0];
    assert.equal(outputAction?.kind, 'swap');
    if (outputAction?.kind === 'swap') {
        assert.equal(outputAction.outputAsset, '0x0000000000000000000000000000000000000000');
    }
});

const marketParams = {
    loanToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    collateralToken: '0x4200000000000000000000000000000000000006',
    oracle: '0xFEa2D58cEfCb9fcb597723c6bAE66fFE4193aFE4',
    irm: '0x46415998764C29aB2a25CbeA6254146D50D22687',
    lltv: 860000000000000000n
} as const;
const user = '0xc766DeF6e80d8538fDfA3627DA27f455794FCD62' as Address;
const morpho = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb' as Address;

function transaction(data: Hex): TransactionEnvelope {
    return { chainId: 8453, from: user, to: morpho, data, value: '0' };
}

function aerodromeTransaction(data: Hex): TransactionEnvelope {
    return {
        chainId: 8453,
        from: user,
        to: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43',
        data,
        value: '0'
    };
}

test('decodes all supported Morpho Blue position operations', () => {
    const vectors = [
        [
            'supply',
            encodeFunctionData({ abi: morphoAbi, functionName: 'supply', args: [marketParams, 1n, 0n, user, '0x'] })
        ],
        [
            'withdraw',
            encodeFunctionData({ abi: morphoAbi, functionName: 'withdraw', args: [marketParams, 1n, 0n, user, user] })
        ],
        [
            'borrow',
            encodeFunctionData({ abi: morphoAbi, functionName: 'borrow', args: [marketParams, 1n, 0n, user, user] })
        ],
        [
            'repay',
            encodeFunctionData({ abi: morphoAbi, functionName: 'repay', args: [marketParams, 1n, 0n, user, '0x'] })
        ],
        [
            'supply-collateral',
            encodeFunctionData({
                abi: morphoAbi,
                functionName: 'supplyCollateral',
                args: [marketParams, 1n, user, '0x']
            })
        ],
        [
            'withdraw-collateral',
            encodeFunctionData({
                abi: morphoAbi,
                functionName: 'withdrawCollateral',
                args: [marketParams, 1n, user, user]
            })
        ]
    ] as const;
    vectors.forEach(([operation, data]) => {
        const intent = decodeTransaction(transaction(data));
        assert.equal(intent.protocol, 'morpho');
        assert.equal(intent.actions[0]?.kind, 'morpho');
        if (intent.actions[0]?.kind === 'morpho') assert.equal(intent.actions[0].operation, operation);
    });
});

test('resolves Morpho share deltas from fixed-block simulation return data', async () => {
    const transaction = await loadTransaction(resolve(fixtures, 'morpho-repay-usdc.base.json'));
    const intent = decodeTransaction(transaction);
    const action = intent.actions[0];
    assert.equal(action?.kind, 'morpho');
    if (action?.kind !== 'morpho' || !intent.transactionFingerprint) return;
    const state: MorphoPreflight = {
        transactionFingerprint: intent.transactionFingerprint,
        status: 'ready',
        blockNumber: '52039476',
        blockHash: `0x${'12'.repeat(32)}`,
        blockTimestamp: 1_790_868_299,
        exposures: [
            {
                actionIndex: 0,
                marketId: action.marketId,
                account: user,
                loanToken: action.marketParams.loanToken,
                collateralToken: action.marketParams.collateralToken,
                operation: 'repay',
                assets: '1000000000',
                shares: '0',
                supplySharesBefore: '20',
                supplySharesAfter: '20',
                borrowSharesBefore: '100',
                borrowSharesAfter: '100',
                collateralBefore: '30',
                collateralAfter: '30',
                totalSupplyAssets: '1000',
                totalSupplyShares: '900',
                totalBorrowAssets: '500',
                totalBorrowShares: '450'
            }
        ]
    };
    const simulation: SimulationResult = {
        attempted: true,
        success: true,
        transactionFingerprint: intent.transactionFingerprint,
        blockNumber: '52039476',
        blockHash: `0x${'12'.repeat(32)}`,
        returnData: encodeAbiParameters(parseAbiParameters('uint256,uint256'), [1_000_000_000n, 90n])
    };
    const resolved = resolveMorpho(intent, state, simulation);
    assert.equal(resolved.intent.actions[0]?.kind, 'morpho');
    assert.equal(resolved.state.exposures[0]?.borrowSharesAfter, '10');
    assert.equal(resolved.intent.expectedBalanceChanges[0]?.amount.value, '1000000000');
});

test('decodes a real Morpho market and rejects a market outside the allowlist', async () => {
    const [transaction, policy] = await Promise.all([
        loadTransaction(resolve(fixtures, 'morpho-repay-usdc.base.json')),
        loadPolicy(resolve('config/policy.example.json'))
    ]);
    const intent = decodeTransaction(transaction);
    const action = intent.actions[0];
    assert.equal(action?.kind, 'morpho');
    if (action?.kind !== 'morpho') return;
    assert.equal(action.marketId, '0x8793cf302b8ffd655ab97bd1c695dbd967807e8367a65cb2f4edaf1380ba1bda');
    const decision = evaluatePolicy(
        intent,
        { ...policy, allowedMorphoMarkets: [] },
        {
            nowSeconds: 1_790_868_301,
            simulation: { attempted: true, success: true }
        }
    );
    assert.ok(decision.findings.some((finding) => finding.code === 'MORPHO_MARKET_NOT_ALLOWED'));
    const callbackDecision = evaluatePolicy(
        {
            ...intent,
            actions: [{ ...action, callbackData: '0x01' }]
        },
        policy,
        {
            nowSeconds: 1_790_868_301,
            simulation: { attempted: true, success: true }
        }
    );
    assert.ok(callbackDecision.findings.some((finding) => finding.code === 'MORPHO_CALLBACK_NOT_ALLOWED'));
});
