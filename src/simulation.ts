import { createPublicClient, http } from "viem";
import { findMoonwellMarket } from "./contracts.js";
import type { Hex, SimulationResult, TransactionEnvelope } from "./domain.js";

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
): Promise<SimulationResult> {
  const client = createPublicClient({ transport: http(rpcUrl) });
  const blockNumber =
    transaction.source === undefined ? undefined : BigInt(transaction.source.blockNumber - 1);
  try {
    const result = await client.call({
      account: transaction.from,
      to: transaction.to,
      data: transaction.data,
      value: BigInt(transaction.value),
      ...(blockNumber === undefined ? {} : { blockNumber }),
    });
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
      rpcUrl: safeRpcUrl(rpcUrl),
      ...(blockNumber === undefined ? {} : { blockNumber: blockNumber.toString() }),
      ...(returnData === undefined ? {} : { returnData }),
    };
  } catch (error) {
    return {
      attempted: true,
      success: false,
      rpcUrl: safeRpcUrl(rpcUrl),
      ...(blockNumber === undefined ? {} : { blockNumber: blockNumber.toString() }),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
