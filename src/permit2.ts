import { rpcTransport } from './rpc.js';
import {
    createPublicClient,
    concatHex,
    decodeAbiParameters,
    encodeAbiParameters,
    getAddress,
    hashTypedData,
    keccak256,
    parseAbi,
    parseAbiParameters,
    recoverAddress,
    sliceHex,
    toBytes,
    toFunctionSelector,
    toHex
} from 'viem';
import {
    BASE_CHAIN_ID,
    BASE_PERMIT2,
    BASE_UNISWAP_UNIVERSAL_ROUTER,
    MSG_SENDER_RECIPIENT,
    ROUTER_RECIPIENT
} from './contracts.js';
import type {
    AuthorizationAction,
    Hex,
    IntentAnalysis,
    Permit2AllowanceEvidence,
    Permit2Check,
    Permit2Detail,
    Permit2Permit,
    Permit2WitnessPermit,
    Permit2Verification,
    PolicyFinding,
    TransactionEnvelope
} from './domain.js';

const detailType = '(address token, uint160 amount, uint48 expiration, uint48 nonce)';
const singleParameters = parseAbiParameters(
    `(${detailType} details, address spender, uint256 sigDeadline) permit, bytes signature`
);
const batchParameters = parseAbiParameters(
    `(${detailType}[] details, address spender, uint256 sigDeadline) permit, bytes signature`
);
const allowanceAbi = parseAbi([
    'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)'
]);
const nonceBitmapAbi = parseAbi(['function nonceBitmap(address owner,uint256 wordPosition) view returns (uint256)']);
const signatureAbi = parseAbi(['function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)']);
const maxAllowance = (1n << 160n) - 1n;
const tokenPermissionParameters = parseAbiParameters('bytes32 typeHash,address token,uint256 amount');
const witnessStructParameters = parseAbiParameters(
    'bytes32 typeHash,bytes32 permitted,address spender,uint256 nonce,uint256 deadline,bytes32 witness'
);
const domainParameters = parseAbiParameters(
    'bytes32 typeHash,bytes32 nameHash,uint256 chainId,address verifyingContract'
);
const tokenPermissionsTypeHash = keccak256(toBytes('TokenPermissions(address token,uint256 amount)'));
const domainTypeHash = keccak256(toBytes('EIP712Domain(string name,uint256 chainId,address verifyingContract)'));
const permit2NameHash = keccak256(toBytes('Permit2'));
const singleWitnessStub =
    'PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,';
const batchWitnessStub =
    'PermitBatchWitnessTransferFrom(TokenPermissions[] permitted,address spender,uint256 nonce,uint256 deadline,';
const singleWitnessSelector = toFunctionSelector(
    'permitWitnessTransferFrom(((address,uint256),uint256,uint256),(address,uint256),address,bytes32,string,bytes)'
);
const batchWitnessSelector = toFunctionSelector(
    'permitWitnessTransferFrom(((address,uint256)[],uint256,uint256),(address,uint256)[],address,bytes32,string,bytes)'
);
const singleWitnessParameters = parseAbiParameters(
    '((address token,uint256 amount) permitted,uint256 nonce,uint256 deadline) permit,(address to,uint256 requestedAmount) transferDetails,address owner,bytes32 witness,string witnessTypeString,bytes signature'
);
const batchWitnessParameters = parseAbiParameters(
    '((address token,uint256 amount)[] permitted,uint256 nonce,uint256 deadline) permit,(address to,uint256 requestedAmount)[] transferDetails,address owner,bytes32 witness,string witnessTypeString,bytes signature'
);

export function transactionFingerprint(transaction: TransactionEnvelope): Hex {
    return keccak256(
        encodeAbiParameters(
            parseAbiParameters('uint256 chainId, address sender, address target, uint256 value, bytes data'),
            [BigInt(transaction.chainId), transaction.from, transaction.to, BigInt(transaction.value), transaction.data]
        )
    );
}

export function decodePermit2Command(
    command: number,
    input: Hex,
    index: number,
    transaction: TransactionEnvelope
): AuthorizationAction {
    if (command === 0x0a || command === 0x03) {
        const [permit, signature] =
            command === 0x0a
                ? decodeAbiParameters(singleParameters, input)
                : decodeAbiParameters(batchParameters, input);
        const rawDetails = Array.isArray(permit.details) ? permit.details : [permit.details];
        const details: Permit2Detail[] = rawDetails.map((detail) => ({
            token: getAddress(detail.token),
            amount: detail.amount.toString(),
            expiration: detail.expiration,
            nonce: detail.nonce
        }));
        return {
            kind: 'authorization',
            index,
            operation: command === 0x0a ? 'permit2-permit' : 'permit2-batch',
            decoded: true,
            permit: {
                type: command === 0x0a ? 'PermitSingle' : 'PermitBatch',
                owner: transaction.from,
                spender: getAddress(permit.spender),
                sigDeadline: permit.sigDeadline.toString(),
                signature,
                details
            }
        };
    }
    if (command === 0x02) {
        const [token, recipient, amount] = decodeAbiParameters(
            parseAbiParameters('address token, address recipient, uint160 amount'),
            input
        );
        const to =
            recipient.toLowerCase() === MSG_SENDER_RECIPIENT.toLowerCase()
                ? transaction.from
                : recipient.toLowerCase() === ROUTER_RECIPIENT.toLowerCase()
                  ? transaction.to
                  : getAddress(recipient);
        return {
            kind: 'authorization',
            index,
            operation: 'permit2-transfer',
            decoded: true,
            transfers: [
                {
                    token: getAddress(token),
                    from: transaction.from,
                    to,
                    amount: amount.toString()
                }
            ]
        };
    }
    if (command !== 0x0d) throw new Error('Unsupported Permit2 command');
    const [transfers] = decodeAbiParameters(
        parseAbiParameters('(address from, address to, uint160 amount, address token)[] transfers'),
        input
    );
    // Batch transferFrom recipients are literal; the Router does not resolve the 0x01/0x02 placeholders.
    return {
        kind: 'authorization',
        index,
        operation: 'permit2-batch',
        decoded: true,
        transfers: transfers.map((transfer) => ({
            from: getAddress(transfer.from),
            to: getAddress(transfer.to),
            token: getAddress(transfer.token),
            amount: transfer.amount.toString()
        }))
    };
}

export function decodePermit2Transaction(transaction: TransactionEnvelope): IntentAnalysis {
    const selector = transaction.data.slice(0, 10).toLowerCase();
    const payload = sliceHex(transaction.data, 4);
    let witnessPermit: Permit2WitnessPermit;
    let transfers: AuthorizationAction['transfers'];
    let transferCount: number;
    if (selector === singleWitnessSelector.toLowerCase()) {
        const [permit, transfer, owner, witness, witnessTypeString, signature] = decodeAbiParameters(
            singleWitnessParameters,
            payload
        );
        const token = getAddress(permit.permitted.token);
        witnessPermit = {
            type: 'PermitWitnessTransferFrom',
            owner: getAddress(owner),
            spender: transaction.from,
            nonce: permit.nonce.toString(),
            deadline: permit.deadline.toString(),
            signature,
            witness,
            witnessTypeString,
            witnessTypeHash: keccak256(toBytes(witnessTypeString)),
            permissions: [{ token, amount: permit.permitted.amount.toString() }]
        };
        transfers = [
            {
                token,
                from: getAddress(owner),
                to: getAddress(transfer.to),
                amount: transfer.requestedAmount.toString()
            }
        ];
        transferCount = 1;
    } else if (selector === batchWitnessSelector.toLowerCase()) {
        const [permit, transferDetails, owner, witness, witnessTypeString, signature] = decodeAbiParameters(
            batchWitnessParameters,
            payload
        );
        const permissions = permit.permitted.map((entry) => ({
            token: getAddress(entry.token),
            amount: entry.amount.toString()
        }));
        witnessPermit = {
            type: 'PermitBatchWitnessTransferFrom',
            owner: getAddress(owner),
            spender: transaction.from,
            nonce: permit.nonce.toString(),
            deadline: permit.deadline.toString(),
            signature,
            witness,
            witnessTypeString,
            witnessTypeHash: keccak256(toBytes(witnessTypeString)),
            permissions
        };
        transfers = transferDetails.flatMap((entry, index) => {
            const permission = permissions[index];
            return permission
                ? [
                      {
                          token: permission.token,
                          from: getAddress(owner),
                          to: getAddress(entry.to),
                          amount: entry.requestedAmount.toString()
                      }
                  ]
                : [];
        });
        transferCount = transferDetails.length;
    } else {
        throw new Error(`Unsupported Permit2 selector ${selector}`);
    }
    const decoded =
        witnessPermit.permissions.length === transferCount &&
        witnessPermit.permissions.length === transfers.length &&
        transfers.length > 0;
    const action: AuthorizationAction = {
        kind: 'authorization',
        index: 0,
        operation:
            witnessPermit.type === 'PermitWitnessTransferFrom' ? 'permit2-witness-transfer' : 'permit2-witness-batch',
        decoded,
        witnessPermit,
        transfers
    };
    return {
        schemaVersion: '1.0',
        protocol: 'permit2',
        adapter: 'permit2-signature-transfer',
        chainId: transaction.chainId,
        sender: transaction.from,
        target: transaction.to,
        nativeValue: transaction.value,
        transactionFingerprint: transactionFingerprint(transaction),
        actions: [action],
        expectedBalanceChanges: transfers.flatMap((transfer) => [
            {
                account: transfer.from,
                asset: transfer.token,
                category: 'asset' as const,
                direction: 'debit' as const,
                amount: { value: transfer.amount, mode: 'exact' as const },
                reason: 'Permit2 witness transfer debit'
            },
            {
                account: transfer.to,
                asset: transfer.token,
                category: 'asset' as const,
                direction: 'credit' as const,
                amount: { value: transfer.amount, mode: 'exact' as const },
                reason: 'Permit2 witness transfer credit'
            }
        ]),
        warnings: decoded
            ? ['Permit2 witness semantics are authorized by an explicit witness type hash allowlist.']
            : ['Permit2 witness permission and transfer counts differ.'],
        ...(transaction.source === undefined ? {} : { source: transaction.source })
    };
}

export function permit2WitnessDigest(permit: Permit2WitnessPermit, chainId: number): Hex {
    if (permit.permissions.length === 0) throw new Error('Permit2 witness permit needs at least one permission');
    const permissionHashes = permit.permissions.map((permission) =>
        keccak256(
            encodeAbiParameters(tokenPermissionParameters, [
                tokenPermissionsTypeHash,
                permission.token,
                BigInt(permission.amount)
            ])
        )
    );
    const permissionHash =
        permit.type === 'PermitWitnessTransferFrom' ? permissionHashes[0]! : keccak256(concatHex(permissionHashes));
    if (permit.type === 'PermitWitnessTransferFrom' && permissionHashes.length !== 1)
        throw new Error('Single Permit2 witness permit needs exactly one permission');
    const typeHash = keccak256(
        toBytes(
            `${permit.type === 'PermitWitnessTransferFrom' ? singleWitnessStub : batchWitnessStub}${permit.witnessTypeString}`
        )
    );
    const structHash = keccak256(
        encodeAbiParameters(witnessStructParameters, [
            typeHash,
            permissionHash,
            permit.spender,
            BigInt(permit.nonce),
            BigInt(permit.deadline),
            permit.witness
        ])
    );
    const domainSeparator = keccak256(
        encodeAbiParameters(domainParameters, [domainTypeHash, permit2NameHash, BigInt(chainId), BASE_PERMIT2])
    );
    return keccak256(concatHex(['0x1901', domainSeparator, structHash]));
}

export function permit2Digest(permit: Permit2Permit, chainId: number): Hex {
    const types = {
        PermitDetails: [
            { name: 'token', type: 'address' },
            { name: 'amount', type: 'uint160' },
            { name: 'expiration', type: 'uint48' },
            { name: 'nonce', type: 'uint48' }
        ],
        [permit.type]: [
            {
                name: 'details',
                type: permit.type === 'PermitSingle' ? 'PermitDetails' : 'PermitDetails[]'
            },
            { name: 'spender', type: 'address' },
            { name: 'sigDeadline', type: 'uint256' }
        ]
    };
    const details = permit.details.map((detail) => ({
        ...detail,
        amount: BigInt(detail.amount)
    }));
    if (permit.type === 'PermitSingle' && details.length !== 1)
        throw new Error('PermitSingle needs exactly one detail');
    // The Permit2 EIP-712 domain does not include a version field.
    return hashTypedData({
        domain: { name: 'Permit2', chainId, verifyingContract: BASE_PERMIT2 },
        types,
        primaryType: permit.type,
        message: {
            details: permit.type === 'PermitSingle' ? details[0] : details,
            spender: permit.spender,
            sigDeadline: BigInt(permit.sigDeadline)
        }
    });
}

export async function recoverPermit2Signer(digest: Hex, signature: Hex): Promise<`0x${string}`> {
    if (signature.length === 130) {
        const packed = BigInt(sliceHex(signature, 32, 64));
        return recoverAddress({
            hash: digest,
            signature: {
                r: sliceHex(signature, 0, 32),
                s: toHex(packed & ((1n << 255n) - 1n), { size: 32 }),
                v: (packed >> 255n) + 27n
            }
        });
    }
    if (signature.length !== 132 || ![27, 28].includes(Number.parseInt(signature.slice(-2), 16))) {
        throw new Error('Invalid Permit2 EOA signature encoding');
    }
    return recoverAddress({ hash: digest, signature });
}

export async function verifyPermit2(
    transaction: TransactionEnvelope,
    intent: IntentAnalysis,
    rpcUrl: string,
    blockNumber?: bigint
): Promise<Permit2Verification> {
    const actions = intent.actions.filter((action) => action.kind === 'authorization');
    const resultBase = {
        transactionFingerprint: transactionFingerprint(transaction),
        contract: BASE_PERMIT2
    };
    const client = createPublicClient({
        transport: rpcTransport(rpcUrl)
    });
    let block;
    try {
        if (
            transaction.chainId !== BASE_CHAIN_ID ||
            ![BASE_UNISWAP_UNIVERSAL_ROUTER, BASE_PERMIT2]
                .map((address) => address.toLowerCase())
                .includes(transaction.to.toLowerCase()) ||
            (await client.getChainId()) !== transaction.chainId
        )
            throw new Error('Unsupported chain or router');
        block = await client.getBlock(blockNumber === undefined ? {} : { blockNumber });
        if (!block.hash || block.number === null) throw new Error('Unconfirmed block');
        const permit2Code = await client.getCode({
            address: BASE_PERMIT2,
            blockNumber: block.number
        });
        if (!permit2Code || permit2Code === '0x') throw new Error('Missing Permit2 deployment');
    } catch {
        return {
            ...resultBase,
            checks: actions.map((action) => ({
                actionIndex: action.index,
                status: 'unavailable',
                allowances: [],
                expectedAllowanceUpdates: [],
                findings: [
                    {
                        code: 'PERMIT2_STATE_UNAVAILABLE',
                        message: 'Cannot confirm the chain, block or Permit2 deployment.',
                        actionIndex: action.index
                    }
                ]
            }))
        };
    }
    const atBlock = { blockNumber: block.number };
    const timestamp = Number(block.timestamp);
    const state = new Map<string, Permit2AllowanceEvidence>();
    const checks: Permit2Check[] = [];
    const keyOf = (owner: string, token: string, spender: string) => `${owner}:${token}:${spender}`.toLowerCase();
    async function allowance(owner: `0x${string}`, token: `0x${string}`, spender: `0x${string}`) {
        const key = keyOf(owner, token, spender);
        const previous = state.get(key);
        if (previous) return previous;
        const [amount, expiration, nonce] = await client.readContract({
            address: BASE_PERMIT2,
            abi: allowanceAbi,
            functionName: 'allowance',
            args: [owner, token, spender],
            ...atBlock
        });
        const record: Permit2AllowanceEvidence = {
            owner,
            token,
            spender,
            amount: amount.toString(),
            expiration,
            nonce,
            source: 'chain'
        };
        state.set(key, record);
        return record;
    }
    for (const action of actions) {
        const findings: PolicyFinding[] = [];
        const allowances: Permit2AllowanceEvidence[] = [];
        const updates: Permit2Check['expectedAllowanceUpdates'][number][] = [];
        let signatureMethod: Permit2Check['signatureMethod'];
        let digest: Hex | undefined;
        let recoveredSigner: `0x${string}` | undefined;
        let unorderedNonce: Permit2Check['unorderedNonce'];
        let unavailable = false;
        const fail = (code: PolicyFinding['code'], message: string) =>
            findings.push({ code, message, actionIndex: action.index });
        try {
            if (action.witnessPermit && action.transfers && action.decoded) {
                const permit = action.witnessPermit;
                digest = permit2WitnessDigest(permit, transaction.chainId);
                const code = await client.getCode({ address: permit.owner, ...atBlock });
                let valid = false;
                if (code && code !== '0x') {
                    signatureMethod = 'eip1271';
                    try {
                        valid =
                            (await client.readContract({
                                address: permit.owner,
                                abi: signatureAbi,
                                functionName: 'isValidSignature',
                                args: [digest, permit.signature],
                                account: BASE_PERMIT2,
                                ...atBlock
                            })) === '0x1626ba7e';
                    } catch {
                        fail(
                            'PERMIT2_STATE_UNAVAILABLE',
                            'EIP-1271 validation reverted or its RPC result was unavailable.'
                        );
                        unavailable = true;
                    }
                } else {
                    signatureMethod = 'eoa';
                    try {
                        recoveredSigner = await recoverPermit2Signer(digest, permit.signature);
                        valid = recoveredSigner.toLowerCase() === permit.owner.toLowerCase();
                    } catch {
                        valid = false;
                    }
                }
                if (!valid && !unavailable)
                    fail(
                        'PERMIT2_SIGNATURE_INVALID',
                        'Permit2 witness signature does not authorize the declared owner and typed data.'
                    );
                if (BigInt(permit.deadline) < BigInt(timestamp))
                    fail('PERMIT2_SIGNATURE_EXPIRED', 'Permit2 witness signature deadline has expired.');
                const nonce = BigInt(permit.nonce);
                const wordPosition = nonce >> 8n;
                const bitPosition = Number(nonce & 255n);
                const bitmap = await client.readContract({
                    address: BASE_PERMIT2,
                    abi: nonceBitmapAbi,
                    functionName: 'nonceBitmap',
                    args: [permit.owner, wordPosition],
                    ...atBlock
                });
                const used = (bitmap & (1n << BigInt(bitPosition))) !== 0n;
                unorderedNonce = {
                    nonce: permit.nonce,
                    wordPosition: wordPosition.toString(),
                    bitPosition,
                    bitmap: bitmap.toString(),
                    used
                };
                if (used) fail('PERMIT2_NONCE_MISMATCH', 'Permit2 witness unordered nonce is already used.');
                if (permit.permissions.length !== action.transfers.length) {
                    fail('PERMIT2_EMPTY_BATCH', 'Permit2 witness permission and transfer counts differ.');
                } else {
                    permit.permissions.forEach((permission, index) => {
                        const transfer = action.transfers?.[index];
                        if (!transfer || transfer.token.toLowerCase() !== permission.token.toLowerCase()) {
                            fail(
                                'UNVERIFIED_AUTHORIZATION',
                                'Permit2 witness transfer token does not match its permission.'
                            );
                        } else if (BigInt(transfer.amount) > BigInt(permission.amount)) {
                            fail(
                                'PERMIT2_ALLOWANCE_INSUFFICIENT',
                                'Permit2 witness transfer exceeds the signed maximum amount.'
                            );
                        }
                    });
                }
            } else if (action.permit) {
                const permit = action.permit;
                digest = permit2Digest(permit, transaction.chainId);
                const code = await client.getCode({
                    address: permit.owner,
                    ...atBlock
                });
                let valid = false;
                if (code && code !== '0x') {
                    signatureMethod = 'eip1271';
                    // Use Permit2 as the caller to match the on-chain signature verification context.
                    try {
                        valid =
                            (await client.readContract({
                                address: permit.owner,
                                abi: signatureAbi,
                                functionName: 'isValidSignature',
                                args: [digest, permit.signature],
                                account: BASE_PERMIT2,
                                ...atBlock
                            })) === '0x1626ba7e';
                    } catch {
                        fail(
                            'PERMIT2_STATE_UNAVAILABLE',
                            'EIP-1271 validation reverted or its RPC result was unavailable.'
                        );
                        unavailable = true;
                    }
                } else {
                    signatureMethod = 'eoa';
                    try {
                        recoveredSigner = await recoverPermit2Signer(digest, permit.signature);
                        valid = recoveredSigner.toLowerCase() === permit.owner.toLowerCase();
                    } catch {
                        valid = false;
                    }
                }
                if (!valid && !unavailable)
                    fail(
                        'PERMIT2_SIGNATURE_INVALID',
                        'Permit2 signature does not authorize the declared owner and typed data.'
                    );
                if (BigInt(permit.sigDeadline) < BigInt(timestamp))
                    fail('PERMIT2_SIGNATURE_EXPIRED', 'Permit2 signature deadline has expired at the checked block.');
                for (const detail of permit.details) {
                    const before = await allowance(permit.owner, detail.token, permit.spender);
                    allowances.push({ ...before });
                    if (before.nonce !== detail.nonce)
                        fail(
                            'PERMIT2_NONCE_MISMATCH',
                            `Permit2 nonce ${detail.nonce} does not match ${before.nonce} for ${detail.token}.`
                        );
                    updates.push({
                        token: detail.token,
                        spender: permit.spender,
                        beforeAmount: before.amount,
                        authorizedAmount: detail.amount,
                        maximumExposureChange: (
                            BigInt(detail.amount) - (before.expiration < timestamp ? 0n : BigInt(before.amount))
                        ).toString(),
                        expiration: detail.expiration === 0 ? timestamp : detail.expiration
                    });
                    if (findings.length === 0)
                        state.set(keyOf(permit.owner, detail.token, permit.spender), {
                            ...before,
                            amount: detail.amount,
                            expiration: detail.expiration === 0 ? timestamp : detail.expiration,
                            nonce: (detail.nonce + 1) % 2 ** 48,
                            source: 'earlier-command'
                        });
                }
            } else if (action.transfers) {
                for (const transfer of action.transfers) {
                    const before = await allowance(transfer.from, transfer.token, transaction.to);
                    allowances.push({ ...before });
                    if (transfer.from.toLowerCase() !== transaction.from.toLowerCase())
                        fail('PERMIT2_OWNER_MISMATCH', 'Permit2 transfer owner must equal the Router sender.');
                    if (before.expiration < timestamp)
                        fail(
                            'PERMIT2_ALLOWANCE_EXPIRED',
                            'Permit2 transfer allowance has expired at the checked block.'
                        );
                    if (BigInt(before.amount) < BigInt(transfer.amount))
                        fail('PERMIT2_ALLOWANCE_INSUFFICIENT', 'Permit2 transfer exceeds the remaining allowance.');
                    if (findings.length === 0 && BigInt(before.amount) !== maxAllowance)
                        state.set(keyOf(transfer.from, transfer.token, transaction.to), {
                            ...before,
                            amount: (BigInt(before.amount) - BigInt(transfer.amount)).toString(),
                            source: 'earlier-command'
                        });
                }
            } else fail('UNVERIFIED_AUTHORIZATION', 'Missing decoded Permit2 authorization details.');
        } catch {
            unavailable = true;
            fail('PERMIT2_STATE_UNAVAILABLE', 'Permit2 verification could not read the required contract state.');
        }
        checks.push({
            actionIndex: action.index,
            status: unavailable ? 'unavailable' : findings.length ? 'invalid' : 'valid',
            allowances,
            expectedAllowanceUpdates: findings.length ? [] : updates,
            findings,
            ...(digest ? { digest } : {}),
            ...(signatureMethod ? { signatureMethod } : {}),
            ...(recoveredSigner ? { recoveredSigner } : {}),
            ...(unorderedNonce ? { unorderedNonce } : {})
        });
        // A failed command cannot provide a new authorization to later commands.
        if (findings.length) state.clear();
    }
    try {
        if ((await client.getBlock(atBlock)).hash !== block.hash) throw new Error('Block changed');
    } catch {
        return {
            ...resultBase,
            checks: actions.map((action) => ({
                actionIndex: action.index,
                status: 'unavailable',
                allowances: [],
                expectedAllowanceUpdates: [],
                findings: [
                    {
                        code: 'PERMIT2_STATE_UNAVAILABLE',
                        message: 'Block changed or could not be reconfirmed after verification.',
                        actionIndex: action.index
                    }
                ]
            }))
        };
    }
    return {
        ...resultBase,
        blockNumber: block.number.toString(),
        blockHash: block.hash,
        blockTimestamp: timestamp,
        checks
    };
}
