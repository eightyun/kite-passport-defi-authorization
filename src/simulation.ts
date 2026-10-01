import { createPublicClient, http } from "viem";
import { findMoonwellMarket } from "./contracts.js";
import type { Hex, SimulationResult, TransactionEnvelope } from "./domain.js";
import { transactionFingerprint } from "./permit2.js";

function safeRpcUrl(rpcUrl: string): string {
  try {
    const url = new URL(rpcUrl);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "invalid-rpc-url";
  }
}

export function skippedSimulation(): SimulationResult {
  return {
    attempted: false,
    success: false,
  };
}

export async function simulateTransaction(
  transaction: TransactionEnvelope,
  rpcUrl: string,
  requestedBlock?: bigint,
): Promise<SimulationResult> {
  const client = createPublicClient({ transport: http(rpcUrl) });
  const blockNumber = requestedBlock ??
    (transaction.source === undefined ? undefined : BigInt(transaction.source.blockNumber - 1));
  try {
    if (await client.getChainId() !== transaction.chainId) throw new Error("RPC chain does not match the transaction.");
    const block = await client.getBlock(blockNumber === undefined ? {} : { blockNumber });
    if (!block.hash || block.number === null) throw new Error("Cannot simulate against an unconfirmed block.");
    const result = await client.call({
      account: transaction.from,
      to: transaction.to,
      data: transaction.data,
      value: BigInt(transaction.value),
      blockNumber: block.number,
    });
    if ((await client.getBlock({ blockNumber: block.number })).hash !== block.hash) {
      throw new Error("Block changed during simulation.");
    }
    const returnData = result.data as Hex | undefined;
    if (
      findMoonwellMarket(transaction.to) !== undefined &&
      returnData !== undefined &&
      returnData.length === 66 &&
      BigInt(returnData) !== 0n
    ) {
      return {
        attempted: true,
        success: false,
        rpcUrl: safeRpcUrl(rpcUrl),
        ...(blockNumber === undefined ? {} : { blockNumber: blockNumber.toString() }),
        returnData,
        error: `Moonwell returned Compound error code ${BigInt(returnData).toString()}.`,
      };
    }
    return {
      attempted: true,
      success: true,
      transactionFingerprint: transactionFingerprint(transaction),
      blockHash: block.hash,
      rpcUrl: safeRpcUrl(rpcUrl),
      blockNumber: block.number.toString(),
      ...(returnData === undefined ? {} : { returnData }),
    };
  } catch {
    return {
      attempted: true,
      success: false,
      rpcUrl: safeRpcUrl(rpcUrl),
      ...(blockNumber === undefined ? {} : { blockNumber: blockNumber.toString() }),
      error: "RPC simulation failed, reverted, or returned data from the wrong chain.",
    };
  }
}
