import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import {
    encodeAbiParameters,
    encodeFunctionData,
    hashTypedData,
    keccak256,
    parseAbi,
    parseAbiParameters,
    toBytes,
    toFunctionSelector,
    toHex
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
    BASE_PERMIT2,
    BASE_UNISWAP_UNIVERSAL_ROUTER,
    BASE_USDC,
    BASE_WETH,
    MSG_SENDER_RECIPIENT,
    ROUTER_RECIPIENT
} from '../src/contracts.js';
import { decodeTransaction } from '../src/decode.js';
import type { Hex, Permit2Permit, Permit2WitnessPermit, PolicyConfig, TransactionEnvelope } from '../src/domain.js';
import { loadPolicy, loadTransaction } from '../src/io.js';
import { permit2Digest, permit2WitnessDigest, recoverPermit2Signer, verifyPermit2 } from '../src/permit2.js';
import { analyzeTransaction, createAuthorizationReport } from '../src/report.js';
import { skippedSimulation } from '../src/simulation.js';

const now = 1_790_835_373;
const account = privateKeyToAccount(generatePrivateKey());
const stranger = '0x1111111111111111111111111111111111111111';
const detail = {
    token: BASE_USDC,
    amount: '100',
    expiration: now + 600,
    nonce: 3
};
const basePermit: Permit2Permit = {
    type: 'PermitSingle',
    owner: account.address,
    spender: BASE_UNISWAP_UNIVERSAL_ROUTER,
    sigDeadline: String(now + 60),
    signature: '0x',
    details: [detail]
};
const detailAbi = '(address token, uint160 amount, uint48 expiration, uint48 nonce)';

async function signed(permit: Permit2Permit = basePermit): Promise<Permit2Permit> {
    return {
        ...permit,
        signature: await account.sign({ hash: permit2Digest(permit, 8453) })
    };
}

function permitInput(permit: Permit2Permit): Hex {
    const details = permit.details.map((entry) => ({
        ...entry,
        amount: BigInt(entry.amount)
    }));
    return permit.type === 'PermitSingle'
        ? encodeAbiParameters(
              parseAbiParameters(
                  `(${detailAbi} details, address spender, uint256 sigDeadline) permit, bytes signature`
              ),
              [
                  {
                      details: details[0]!,
                      spender: permit.spender,
                      sigDeadline: BigInt(permit.sigDeadline)
                  },
                  permit.signature
              ]
          )
        : encodeAbiParameters(
              parseAbiParameters(
                  `(${detailAbi}[] details, address spender, uint256 sigDeadline) permit, bytes signature`
              ),
              [
                  {
                      details,
                      spender: permit.spender,
                      sigDeadline: BigInt(permit.sigDeadline)
                  },
                  permit.signature
              ]
          );
}

function transaction(commands: Hex, inputs: readonly Hex[]): TransactionEnvelope {
    return {
        chainId: 8453,
        from: account.address,
        to: BASE_UNISWAP_UNIVERSAL_ROUTER,
        value: '0',
        data: encodeFunctionData({
            abi: parseAbi(['function execute(bytes commands, bytes[] inputs) payable']),
            functionName: 'execute',
            args: [commands, inputs]
        })
    };
}

function transferInput(amount: bigint, recipient = MSG_SENDER_RECIPIENT): Hex {
    return encodeAbiParameters(parseAbiParameters('address token, address recipient, uint160 amount'), [
        BASE_USDC,
        recipient,
        amount
    ]);
}

interface RpcOptions {
    nonce?: number;
    amount?: bigint;
    expiration?: number;
    contractOwner?: boolean;
    magic?: Hex;
    chainId?: number;
    failSimulation?: boolean;
    failAllowance?: boolean;
    nonceBitmap?: bigint;
}

const nonceBitmapSelector = toFunctionSelector('nonceBitmap(address,uint256)').toLowerCase();

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
        let error: { code: number; message: string } | undefined;
        if (body.method === 'eth_chainId') result = toHex(options.chainId ?? 8453);
        else if (body.method === 'eth_getBlockByNumber')
            result = {
                number: '0x64',
                hash: `0x${'aa'.repeat(32)}`,
                timestamp: toHex(now),
                transactions: [],
                gasLimit: '0x1000000',
                gasUsed: '0x0',
                size: '0x1',
                difficulty: '0x0',
                totalDifficulty: '0x0',
                baseFeePerGas: '0x1'
            };
        else if (body.method === 'eth_getCode') {
            const address = String(body.params[0]).toLowerCase();
            result = address === BASE_PERMIT2.toLowerCase() || options.contractOwner ? '0x6000' : '0x';
        } else if (body.method === 'eth_call') {
            const call = body.params[0] as {
                to: string;
                data: string;
                from?: string;
            };
            if (call.to.toLowerCase() === BASE_PERMIT2.toLowerCase()) {
                if (options.failAllowance) error = { code: -32000, message: 'state unavailable' };
                else if (call.data.slice(0, 10).toLowerCase() === nonceBitmapSelector)
                    result = encodeAbiParameters(parseAbiParameters('uint256'), [options.nonceBitmap ?? 0n]);
                else
                    result = encodeAbiParameters(
                        parseAbiParameters('uint160 amount, uint48 expiration, uint48 nonce'),
                        [options.amount ?? 100n, options.expiration ?? now + 600, options.nonce ?? 3]
                    );
            } else if (call.to.toLowerCase() === account.address.toLowerCase()) {
                assert.equal(call.from?.toLowerCase(), BASE_PERMIT2.toLowerCase());
                result = encodeAbiParameters(parseAbiParameters('bytes4'), [options.magic ?? '0x1626ba7e']);
            } else if (options.failSimulation) error = { code: 3, message: 'execution reverted' };
            else result = '0x';
        } else error = { code: -32601, message: 'unexpected method' };
        response.setHeader('content-type', 'application/json');
        response.end(
            JSON.stringify({
                jsonrpc: '2.0',
                id: body.id,
                ...(error ? { error } : { result })
            })
        );
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

async function report(tx: TransactionEnvelope, rpcUrl: string, policy?: PolicyConfig) {
    return analyzeTransaction(tx, policy ?? (await loadPolicy('config/policy.example.json')), {
        rpcUrl,
        nowSeconds: now,
        generatedAt: new Date(now * 1000).toISOString()
    });
}

test('independently recovers the signer from an unmodified real Base Permit2 transaction', async () => {
    const tx = await loadTransaction('fixtures/transactions/uniswap-permit2-usdc.base.json');
    const action = decodeTransaction(tx).actions[0];
    assert.ok(action?.kind === 'authorization' && action.permit);
    assert.equal(action.permit.details[0]?.amount, ((1n << 160n) - 1n).toString());
    assert.equal(action.permit.details[0]?.token, BASE_USDC);
    assert.equal(action.permit.details[0]?.nonce, 0);
    assert.equal(
        (await recoverPermit2Signer(permit2Digest(action.permit, tx.chainId), action.permit.signature)).toLowerCase(),
        tx.from.toLowerCase()
    );
    const wrong = await recoverPermit2Signer(permit2Digest(action.permit, 1), action.permit.signature);
    assert.notEqual(wrong.toLowerCase(), tx.from.toLowerCase());
});

test('decodes and verifies a direct Permit2 witness transfer at a fixed block', async () => {
    const witnessTypeString =
        'ExampleTrade witness)ExampleTrade(bytes32 orderHash)TokenPermissions(address token,uint256 amount)';
    const orderHash = `0x${'34'.repeat(32)}` as Hex;
    const witness = keccak256(
        encodeAbiParameters(parseAbiParameters('bytes32 typeHash,bytes32 orderHash'), [
            keccak256(toBytes('ExampleTrade(bytes32 orderHash)')),
            orderHash
        ])
    );
    const unsigned: Permit2WitnessPermit = {
        type: 'PermitWitnessTransferFrom',
        owner: account.address,
        spender: account.address,
        nonce: '1',
        deadline: String(now + 60),
        signature: '0x',
        witness,
        witnessTypeString,
        witnessTypeHash: keccak256(toBytes(witnessTypeString)),
        permissions: [{ token: BASE_USDC, amount: '100' }]
    };
    const independentDigest = hashTypedData({
        domain: { name: 'Permit2', chainId: 8453, verifyingContract: BASE_PERMIT2 },
        types: {
            TokenPermissions: [
                { name: 'token', type: 'address' },
                { name: 'amount', type: 'uint256' }
            ],
            ExampleTrade: [{ name: 'orderHash', type: 'bytes32' }],
            PermitWitnessTransferFrom: [
                { name: 'permitted', type: 'TokenPermissions' },
                { name: 'spender', type: 'address' },
                { name: 'nonce', type: 'uint256' },
                { name: 'deadline', type: 'uint256' },
                { name: 'witness', type: 'ExampleTrade' }
            ]
        },
        primaryType: 'PermitWitnessTransferFrom',
        message: {
            permitted: { token: BASE_USDC, amount: 100n },
            spender: account.address,
            nonce: 1n,
            deadline: BigInt(now + 60),
            witness: { orderHash }
        }
    });
    assert.equal(permit2WitnessDigest(unsigned, 8453), independentDigest);
    const permit = { ...unsigned, signature: await account.sign({ hash: permit2WitnessDigest(unsigned, 8453) }) };
    const data = encodeFunctionData({
        abi: parseAbi([
            'function permitWitnessTransferFrom(((address token,uint256 amount) permitted,uint256 nonce,uint256 deadline) permit,(address to,uint256 requestedAmount) transferDetails,address owner,bytes32 witness,string witnessTypeString,bytes signature)'
        ]),
        functionName: 'permitWitnessTransferFrom',
        args: [
            {
                permitted: { token: BASE_USDC, amount: 100n },
                nonce: 1n,
                deadline: BigInt(now + 60)
            },
            { to: account.address, requestedAmount: 60n },
            account.address,
            permit.witness,
            witnessTypeString,
            permit.signature
        ]
    });
    const tx: TransactionEnvelope = {
        chainId: 8453,
        from: account.address,
        to: BASE_PERMIT2,
        value: '0',
        data
    };
    const intent = decodeTransaction(tx);
    const action = intent.actions[0];
    assert.equal(intent.protocol, 'permit2');
    assert.ok(action?.kind === 'authorization' && action.witnessPermit);
    assert.equal(action.witnessPermit.witnessTypeHash, permit.witnessTypeHash);
    assert.equal(action.transfers?.[0]?.amount, '60');

    const policy = await loadPolicy('config/policy.example.json');
    const witnessPolicy: PolicyConfig = {
        ...policy,
        allowedTargets: [...policy.allowedTargets, BASE_PERMIT2],
        allowedPermit2WitnessTypeHashes: [permit.witnessTypeHash]
    };
    const node = await rpc();
    try {
        const checked = await report(tx, node.url, witnessPolicy);
        assert.equal(checked.finalDecision, 'pass');
        assert.equal(checked.permit2?.checks[0]?.unorderedNonce?.used, false);
        assert.equal(checked.permit2?.checks[0]?.digest, permit2WitnessDigest(permit, 8453));

        const blockedType = await report(tx, node.url, { ...witnessPolicy, allowedPermit2WitnessTypeHashes: [] });
        assert.ok(blockedType.policy.findings.some((item) => item.code === 'PERMIT2_WITNESS_TYPE_NOT_ALLOWED'));
        const usedNonceNode = await rpc({ nonceBitmap: 2n });
        try {
            const used = await report(tx, usedNonceNode.url, witnessPolicy);
            assert.ok(used.policy.findings.some((item) => item.code === 'PERMIT2_NONCE_MISMATCH'));
        } finally {
            await usedNonceNode.close();
        }
    } finally {
        await node.close();
    }
});

test('decodes and verifies a direct Permit2 batch witness transfer', async () => {
    const witnessTypeString =
        'BatchOrder witness)BatchOrder(bytes32 orderHash)TokenPermissions(address token,uint256 amount)';
    const unsigned: Permit2WitnessPermit = {
        type: 'PermitBatchWitnessTransferFrom',
        owner: account.address,
        spender: account.address,
        nonce: '7',
        deadline: String(now + 60),
        signature: '0x',
        witness: `0x${'56'.repeat(32)}`,
        witnessTypeString,
        witnessTypeHash: keccak256(toBytes(witnessTypeString)),
        permissions: [
            { token: BASE_USDC, amount: '100' },
            { token: BASE_WETH, amount: '50' }
        ]
    };
    const permit = { ...unsigned, signature: await account.sign({ hash: permit2WitnessDigest(unsigned, 8453) }) };
    const data = encodeFunctionData({
        abi: parseAbi([
            'function permitWitnessTransferFrom(((address token,uint256 amount)[] permitted,uint256 nonce,uint256 deadline) permit,(address to,uint256 requestedAmount)[] transferDetails,address owner,bytes32 witness,string witnessTypeString,bytes signature)'
        ]),
        functionName: 'permitWitnessTransferFrom',
        args: [
            {
                permitted: [
                    { token: BASE_USDC, amount: 100n },
                    { token: BASE_WETH, amount: 50n }
                ],
                nonce: 7n,
                deadline: BigInt(now + 60)
            },
            [
                { to: account.address, requestedAmount: 60n },
                { to: account.address, requestedAmount: 40n }
            ],
            account.address,
            permit.witness,
            witnessTypeString,
            permit.signature
        ]
    });
    const tx: TransactionEnvelope = {
        chainId: 8453,
        from: account.address,
        to: BASE_PERMIT2,
        value: '0',
        data
    };
    const policy = await loadPolicy('config/policy.example.json');
    const node = await rpc();
    try {
        const checked = await report(tx, node.url, {
            ...policy,
            allowedPermit2WitnessTypeHashes: [permit.witnessTypeHash]
        });
        assert.equal(checked.finalDecision, 'pass');
        assert.equal(checked.intent.actions[0]?.kind, 'authorization');
        assert.equal(checked.intent.actions[0]?.operation, 'permit2-witness-batch');
        assert.equal(checked.intent.expectedBalanceChanges.length, 4);
    } finally {
        await node.close();
    }
});

test('accepts an EOA permit only with nonce verification and matching full-transaction simulation', async () => {
    const node = await rpc();
    try {
        const tx = transaction('0x0a', [permitInput(await signed())]);
        const checked = await report(tx, node.url);
        assert.equal(checked.finalDecision, 'pass');
        assert.equal(checked.permit2?.checks[0]?.signatureMethod, 'eoa');
        assert.equal(checked.permit2?.checks[0]?.allowances[0]?.nonce, 3);
        assert.equal(checked.permit2?.checks[0]?.expectedAllowanceUpdates[0]?.authorizedAmount, '100');
        assert.equal(checked.permit2?.blockHash, checked.simulation.blockHash);
        const policy = await loadPolicy('config/policy.example.json');
        const skipped = createAuthorizationReport(tx, policy, {
            nowSeconds: now,
            generatedAt: checked.generatedAt,
            simulation: skippedSimulation(),
            permit2: checked.permit2!
        });
        assert.equal(skipped.finalDecision, 'reject');
        const altered = transaction('0x0a', [
            permitInput(await signed({ ...basePermit, sigDeadline: String(now + 80) }))
        ]);
        const mismatched = createAuthorizationReport(altered, policy, {
            nowSeconds: now,
            generatedAt: checked.generatedAt,
            simulation: checked.simulation,
            permit2: checked.permit2!
        });
        assert.equal(mismatched.finalDecision, 'reject');
    } finally {
        await node.close();
    }
});

test('validates EIP-2098 compact signatures with the Permit2 domain', async () => {
    const permit = await signed();
    const s = BigInt(`0x${permit.signature.slice(66, 130)}`);
    const parity = BigInt(Number.parseInt(permit.signature.slice(130), 16) - 27);
    const compact = `${permit.signature.slice(0, 66)}${toHex(s | (parity << 255n), { size: 32 }).slice(2)}` as Hex;
    assert.equal(await recoverPermit2Signer(permit2Digest(permit, 8453), compact), account.address);
});

test('verifies PermitBatch and rejects a tampered batch member', async () => {
    const permit = await signed({
        ...basePermit,
        type: 'PermitBatch',
        details: [detail, { ...detail, token: BASE_WETH }]
    });
    const node = await rpc();
    try {
        const checked = await report(transaction('0x03', [permitInput(permit)]), node.url);
        assert.equal(checked.finalDecision, 'pass');
        assert.equal(checked.permit2?.checks[0]?.allowances.length, 2);
        const tampered = {
            ...permit,
            details: [detail, { ...detail, token: BASE_WETH, amount: '101' }]
        };
        const invalid = await report(transaction('0x03', [permitInput(tampered)]), node.url);
        assert.ok(invalid.policy.findings.some((item) => item.code === 'PERMIT2_SIGNATURE_INVALID'));
    } finally {
        await node.close();
    }
});

test('checks contract-wallet EIP-1271 magic value at the same block and caller as Permit2', async () => {
    for (const magic of ['0x1626ba7e', '0xffffffff'] as const) {
        const node = await rpc({ contractOwner: true, magic });
        try {
            const checked = await report(
                transaction('0x0a', [permitInput({ ...basePermit, signature: '0x1234' })]),
                node.url
            );
            assert.equal(checked.permit2?.checks[0]?.signatureMethod, 'eip1271');
            assert.equal(checked.finalDecision, magic === '0x1626ba7e' ? 'pass' : 'reject');
        } finally {
            await node.close();
        }
    }
});

test('applies earlier permits and cumulative transfer consumption in Router order', async () => {
    const node = await rpc({ amount: 0n });
    try {
        const input = permitInput(await signed());
        const valid = await report(
            transaction('0x0a0202', [input, transferInput(60n, ROUTER_RECIPIENT), transferInput(40n)]),
            node.url
        );
        assert.equal(valid.finalDecision, 'pass');
        assert.equal(valid.permit2?.checks[2]?.allowances[0]?.amount, '40');
        assert.equal(valid.intent.expectedBalanceChanges.length, 4);
        const invalid = await report(
            transaction('0x0a0202', [input, transferInput(60n), transferInput(41n)]),
            node.url
        );
        assert.ok(invalid.policy.findings.some((item) => item.code === 'PERMIT2_ALLOWANCE_INSUFFICIENT'));
        const nonceReuse = await report(transaction('0x0a0a', [input, input]), node.url);
        assert.ok(nonceReuse.policy.findings.some((item) => item.code === 'PERMIT2_NONCE_MISMATCH'));
    } finally {
        await node.close();
    }
});

test('batch transfers retain literal recipients, validate owners and report balance changes', async () => {
    const input = encodeAbiParameters(
        parseAbiParameters('(address from, address to, uint160 amount, address token)[]'),
        [
            [
                {
                    from: account.address,
                    to: MSG_SENDER_RECIPIENT,
                    amount: 1n,
                    token: BASE_USDC
                },
                { from: stranger, to: account.address, amount: 1n, token: BASE_USDC }
            ]
        ]
    );
    const tx = transaction('0x0d', [input]);
    const intent = decodeTransaction(tx);
    assert.equal(intent.expectedBalanceChanges[1]?.account, MSG_SENDER_RECIPIENT);
    const node = await rpc();
    try {
        const checked = await report(tx, node.url);
        assert.ok(checked.policy.findings.some((item) => item.code === 'PERMIT2_OWNER_MISMATCH'));
        assert.ok(checked.policy.findings.some((item) => item.code === 'UNAPPROVED_RECIPIENT'));
    } finally {
        await node.close();
    }
});

test('Permit2 rejection paths cover authorization constraints and missing state', async (context) => {
    const policy = await loadPolicy('config/policy.example.json');
    const cases: {
        name: string;
        code: string;
        permit?: Permit2Permit;
        rpc?: RpcOptions;
        policy?: PolicyConfig;
        transfer?: Hex;
    }[] = [
        {
            name: 'wrong spender',
            code: 'PERMIT2_SPENDER_NOT_ALLOWED',
            permit: { ...basePermit, spender: stranger }
        },
        {
            name: 'expired signature',
            code: 'PERMIT2_SIGNATURE_EXPIRED',
            permit: { ...basePermit, sigDeadline: String(now - 1) }
        },
        {
            name: 'excessive signature lifetime',
            code: 'PERMIT2_SIGNATURE_DEADLINE_TOO_FAR',
            permit: { ...basePermit, sigDeadline: String(now + 3601) }
        },
        {
            name: 'expired allowance',
            code: 'PERMIT2_ALLOWANCE_EXPIRED',
            permit: { ...basePermit, details: [{ ...detail, expiration: now - 1 }] }
        },
        {
            name: 'excessive allowance lifetime',
            code: 'PERMIT2_EXPIRATION_TOO_FAR',
            permit: {
                ...basePermit,
                details: [{ ...detail, expiration: now + 86401 }]
            }
        },
        {
            name: 'unknown token',
            code: 'UNAPPROVED_TOKEN',
            permit: { ...basePermit, details: [{ ...detail, token: stranger }] }
        },
        {
            name: 'missing cap',
            code: 'PERMIT2_LIMIT_MISSING',
            policy: { ...policy, maximumAmountByToken: {} }
        },
        {
            name: 'unlimited grant',
            code: 'AMOUNT_LIMIT_EXCEEDED',
            permit: {
                ...basePermit,
                details: [{ ...detail, amount: ((1n << 160n) - 1n).toString() }]
            }
        },
        { name: 'used nonce', code: 'PERMIT2_NONCE_MISMATCH', rpc: { nonce: 4 } },
        {
            name: 'wrong chain',
            code: 'PERMIT2_STATE_UNAVAILABLE',
            rpc: { chainId: 1 }
        },
        {
            name: 'unavailable state',
            code: 'PERMIT2_STATE_UNAVAILABLE',
            rpc: { failAllowance: true }
        },
        {
            name: 'full call reverted',
            code: 'SIMULATION_FAILED',
            rpc: { failSimulation: true }
        },
        {
            name: 'empty permit batch',
            code: 'PERMIT2_EMPTY_BATCH',
            permit: { ...basePermit, type: 'PermitBatch', details: [] }
        },
        {
            name: 'transfer exceeds allowance',
            code: 'PERMIT2_ALLOWANCE_INSUFFICIENT',
            transfer: transferInput(101n)
        },
        {
            name: 'transfer allowance expired',
            code: 'PERMIT2_ALLOWANCE_EXPIRED',
            transfer: transferInput(1n),
            rpc: { expiration: now - 1 }
        },
        {
            name: 'transfer to stranger',
            code: 'UNAPPROVED_RECIPIENT',
            transfer: transferInput(1n, stranger)
        }
    ];
    for (const scenario of cases)
        await context.test(scenario.name, async () => {
            const node = await rpc(scenario.rpc);
            try {
                const permit = await signed(scenario.permit);
                const tx = scenario.transfer
                    ? transaction('0x02', [scenario.transfer])
                    : transaction(permit.type === 'PermitSingle' ? '0x0a' : '0x03', [permitInput(permit)]);
                const checked = await report(tx, node.url, scenario.policy);
                assert.equal(checked.finalDecision, 'reject');
                assert.ok(
                    checked.policy.findings.some((item) => item.code === scenario.code),
                    JSON.stringify(checked.policy)
                );
            } finally {
                await node.close();
            }
        });
});

test('a decoded Permit2 action cannot pass the offline reporting API without verification', async () => {
    const tx = transaction('0x0a', [permitInput(await signed())]);
    const checked = createAuthorizationReport(tx, await loadPolicy('config/policy.example.json'), {
        nowSeconds: now,
        generatedAt: new Date(now * 1000).toISOString(),
        simulation: skippedSimulation()
    });
    assert.equal(checked.finalDecision, 'reject');
    assert.ok(checked.policy.findings.some((item) => item.code === 'UNVERIFIED_AUTHORIZATION'));
});

test('rejects a split-transfer attempt to bypass the per-transaction amount limit', async () => {
    const node = await rpc({ amount: (1n << 160n) - 1n });
    try {
        const policy = await loadPolicy('config/policy.example.json');
        const checked = await report(transaction('0x0202', [transferInput(60n), transferInput(60n)]), node.url, {
            ...policy,
            maximumAmountByToken: { [BASE_USDC.toLowerCase()]: '100' }
        });
        assert.ok(checked.policy.findings.some((item) => item.code === 'AMOUNT_LIMIT_EXCEEDED'));
    } finally {
        await node.close();
    }
});

test('zero expiration takes the block timestamp and repeated batch nonces cannot pass', async () => {
    const node = await rpc();
    try {
        const immediate = await signed({
            ...basePermit,
            details: [{ ...detail, expiration: 0 }]
        });
        const valid = await report(transaction('0x0a02', [permitInput(immediate), transferInput(100n)]), node.url);
        assert.equal(valid.finalDecision, 'pass');
        assert.equal(valid.permit2?.checks[0]?.expectedAllowanceUpdates[0]?.expiration, now);
        const duplicate = await signed({
            ...basePermit,
            type: 'PermitBatch',
            details: [detail, detail]
        });
        const invalid = await report(transaction('0x03', [permitInput(duplicate)]), node.url);
        assert.ok(invalid.policy.findings.some((item) => item.code === 'PERMIT2_NONCE_MISMATCH'));
    } finally {
        await node.close();
    }
});

test('invalid EOA signature bytes and a mismatched EIP-712 domain fail closed', async () => {
    const node = await rpc();
    try {
        for (const signature of ['0x1234', await account.sign({ hash: permit2Digest(basePermit, 1) })] as const) {
            const checked = await report(transaction('0x0a', [permitInput({ ...basePermit, signature })]), node.url);
            assert.ok(checked.policy.findings.some((item) => item.code === 'PERMIT2_SIGNATURE_INVALID'));
        }
    } finally {
        await node.close();
    }
});

test('successfully decodes and checks a batch transfer using existing allowances', async () => {
    const node = await rpc();
    try {
        const input = encodeAbiParameters(
            parseAbiParameters('(address from, address to, uint160 amount, address token)[]'),
            [
                [
                    {
                        from: account.address,
                        to: account.address,
                        amount: 60n,
                        token: BASE_USDC
                    },
                    {
                        from: account.address,
                        to: BASE_UNISWAP_UNIVERSAL_ROUTER,
                        amount: 40n,
                        token: BASE_USDC
                    }
                ]
            ]
        );
        const checked = await report(transaction('0x0d', [input]), node.url);
        assert.equal(checked.finalDecision, 'pass');
        assert.equal(checked.permit2?.checks[0]?.allowances[1]?.amount, '40');
    } finally {
        await node.close();
    }
});
