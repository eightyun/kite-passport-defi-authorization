import { rpcTransport } from './rpc.js';
import { createPublicClient, decodeAbiParameters, parseAbiParameters, sliceHex, toFunctionSelector } from 'viem';
import { BASE_MOONWELL_COMPTROLLER, findMoonwellMarket } from './contracts.js';
import type { Hex, SimulationResult, TransactionEnvelope } from './domain.js';
import { transactionFingerprint } from './permit2.js';

function safeRpcUrl(rpcUrl: string): string {
    try {
        const url = new URL(rpcUrl);
        return `${url.protocol}//${url.host}`;
    } catch {
        return 'invalid-rpc-url';
    }
}

export function skippedSimulation(): SimulationResult {
    return {
        attempted: false,
        success: false
    };
}

export async function simulateTransaction(
    transaction: TransactionEnvelope,
    rpcUrl: string,
    requestedBlock?: bigint
): Promise<SimulationResult> {
    const client = createPublicClient({ transport: rpcTransport(rpcUrl) });
    const blockNumber =
        requestedBlock ?? (transaction.source === undefined ? undefined : BigInt(transaction.source.blockNumber - 1));
    try {
        if ((await client.getChainId()) !== transaction.chainId)
            throw new Error('RPC chain does not match the transaction.');
        const block = await client.getBlock(blockNumber === undefined ? {} : { blockNumber });
        if (!block.hash || block.number === null) throw new Error('Cannot simulate against an unconfirmed block.');
        const result = await client.call({
            account: transaction.from,
            to: transaction.to,
            data: transaction.data,
            value: BigInt(transaction.value),
            blockNumber: block.number
        });
        if ((await client.getBlock({ blockNumber: block.number })).hash !== block.hash) {
            throw new Error('Block changed during simulation.');
        }
        const returnData = result.data as Hex | undefined;
        let protocolError: string | undefined;
        const isController = transaction.to.toLowerCase() === BASE_MOONWELL_COMPTROLLER.toLowerCase();
        if (findMoonwellMarket(transaction.to) || isController) {
            try {
                if (
                    isController &&
                    transaction.data.slice(0, 10).toLowerCase() === toFunctionSelector('enterMarkets(address[])')
                ) {
                    const [markets] = decodeAbiParameters(
                        parseAbiParameters('address[]'),
                        sliceHex(transaction.data, 4)
                    );
                    const [codes] = decodeAbiParameters(parseAbiParameters('uint256[]'), returnData ?? '0x');
                    if (codes.length !== markets.length) throw new Error('Wrong return count');
                    const failures = codes.flatMap((code, index) => (code === 0n ? [] : [`market ${index}: ${code}`]));
                    if (failures.length)
                        protocolError = `Moonwell returned Compound error codes (${failures.join(', ')}).`;
                } else {
                    if (returnData?.length !== 66) throw new Error('Invalid scalar return');
                    const [code] = decodeAbiParameters(parseAbiParameters('uint256'), returnData);
                    if (code !== 0n) protocolError = `Moonwell returned Compound error code ${code}.`;
                }
            } catch {
                protocolError = 'Moonwell returned missing or malformed protocol error codes.';
            }
        }
        return {
            attempted: true,
            success: protocolError === undefined,
            ...(protocolError ? { error: protocolError } : {}),
            transactionFingerprint: transactionFingerprint(transaction),
            blockHash: block.hash,
            rpcUrl: safeRpcUrl(rpcUrl),
            blockNumber: block.number.toString(),
            ...(returnData === undefined ? {} : { returnData })
        };
    } catch {
        return {
            attempted: true,
            success: false,
            rpcUrl: safeRpcUrl(rpcUrl),
            ...(blockNumber === undefined ? {} : { blockNumber: blockNumber.toString() }),
            error: 'RPC simulation failed, reverted, or returned data from the wrong chain.'
        };
    }
}
