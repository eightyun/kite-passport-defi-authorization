import {
  createPublicClient,
  getAddress,
  hashTypedData,
  parseAbi,
  recoverTypedDataAddress,
  type TypedData,
} from "viem";
import { BASE_AVANTIS_TRADING_ROUTER, BASE_CHAIN_ID } from "./contracts.js";
import type {
  Address,
  AvantisAction,
  AvantisIntentCheck,
  AvantisPreflight,
  IntentAnalysis,
  SimulationResult,
  TransactionEnvelope,
} from "./domain.js";
import { transactionFingerprint } from "./permit2.js";
import { rpcTransport } from "./rpc.js";

const stateAbi = parseAbi([
  "function nonceBitmap(address signer,uint256 wordPos) view returns (uint256)",
  "function multipleDelegations(address trader,address delegate) view returns (bool isEnabled,uint256 expiry)",
]);

const tradeType = [
  { name: "trader", type: "address" }, { name: "pairIndex", type: "uint256" },
  { name: "index", type: "uint256" }, { name: "initialPosToken", type: "uint256" },
  { name: "positionSizeUSDC", type: "uint256" }, { name: "openPrice", type: "uint256" },
  { name: "buy", type: "bool" }, { name: "leverage", type: "uint256" },
  { name: "tp", type: "uint256" }, { name: "sl", type: "uint256" },
  { name: "timestamp", type: "uint256" },
] as const;
const updatePositionType = [
  { name: "trader", type: "address" }, { name: "pairIndex", type: "uint256" },
  { name: "index", type: "uint256" }, { name: "openPrice", type: "uint256" },
  { name: "initialPosToken", type: "uint256" }, { name: "leverage", type: "uint256" },
] as const;

const intentTypes: Readonly<Record<string, TypedData>> = {
  OpenTradeReq: {
    OpenTradeReq: [
      { name: "_t", type: "Trade" }, { name: "_type", type: "uint8" },
      { name: "_slippageP", type: "uint256" }, { name: "_deadline", type: "uint256" },
      { name: "_nonce", type: "uint256" },
    ], Trade: tradeType,
  },
  OpenTradeCoinExposureReq: {
    OpenTradeCoinExposureReq: [
      { name: "_t", type: "Trade" }, { name: "_type", type: "uint8" },
      { name: "_coinExposure", type: "uint256" }, { name: "_minLeverage", type: "uint256" },
      { name: "_maxLeverage", type: "uint256" }, { name: "_slippageP", type: "uint256" },
      { name: "_deadline", type: "uint256" }, { name: "_nonce", type: "uint256" },
    ], Trade: tradeType,
  },
  CloseTradeReq: { CloseTradeReq: [
    { name: "_trader", type: "address" }, { name: "_pairIndex", type: "uint256" },
    { name: "_index", type: "uint256" }, { name: "_openTimestamp", type: "uint256" },
    { name: "_amount", type: "uint256" }, { name: "_wantedPrice", type: "uint256" },
    { name: "_deadline", type: "uint256" }, { name: "_nonce", type: "uint256" },
  ] },
  CloseTradeCoinExposureReq: { CloseTradeCoinExposureReq: [
    { name: "_trader", type: "address" }, { name: "_pairIndex", type: "uint256" },
    { name: "_index", type: "uint256" }, { name: "_openTimestamp", type: "uint256" },
    { name: "_coinExposure", type: "uint256" }, { name: "_wantedPrice", type: "uint256" },
    { name: "_deadline", type: "uint256" }, { name: "_nonce", type: "uint256" },
  ] },
  IncreasePositionSizeReq: {
    IncreasePositionSizeReq: [
      { name: "_updateInfo", type: "UpdatePositionSize" }, { name: "_slippageP", type: "uint256" },
      { name: "_deadline", type: "uint256" }, { name: "_nonce", type: "uint256" },
    ], UpdatePositionSize: updatePositionType,
  },
  IncreasePositionSizeWithCoinExposureReq: {
    IncreasePositionSizeWithCoinExposureReq: [
      { name: "_updateInfo", type: "UpdatePositionSize" }, { name: "_coinExposure", type: "uint256" },
      { name: "_minLeverage", type: "uint256" }, { name: "_maxLeverage", type: "uint256" },
      { name: "_slippageP", type: "uint256" }, { name: "_deadline", type: "uint256" },
      { name: "_nonce", type: "uint256" },
    ], UpdatePositionSize: updatePositionType,
  },
};

function integerMessage(value: unknown): unknown {
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  if (Array.isArray(value)) return value.map(integerMessage);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, integerMessage(entry)]));
  }
  return value;
}

async function verifyIntent(
  action: AvantisAction,
  blockTimestamp: number,
  readNonce: (signer: Address, word: bigint) => Promise<bigint>,
  readDelegation: (trader: Address, signer: Address) => Promise<readonly [boolean, bigint]>,
): Promise<AvantisIntentCheck> {
  const base = { actionIndex: action.index, trader: action.trader, nonce: action.nonce ?? "0" };
  if (!action.intentType || !action.intentMessage || !action.signature || !action.deadlineMs || !action.nonce) {
    return { ...base, status: "invalid", error: "Signed Avantis intent is incomplete." };
  }
  const domain = {
    name: "AvantisTrading", version: "1", chainId: BASE_CHAIN_ID,
    verifyingContract: BASE_AVANTIS_TRADING_ROUTER,
  } as const;
  const types = intentTypes[action.intentType];
  if (!types) return { ...base, status: "invalid", error: "Unsupported Avantis intent type." };
  let digest: `0x${string}`;
  let signer: Address;
  try {
    const message = integerMessage(action.intentMessage) as Record<string, unknown>;
    const typedData = { domain, types, primaryType: action.intentType, message };
    digest = hashTypedData(typedData);
    signer = getAddress(await recoverTypedDataAddress({ ...typedData, signature: action.signature })) as Address;
  } catch {
    return { ...base, status: "invalid", error: "Avantis EIP-712 signature or intent encoding is invalid." };
  }
  if (BigInt(action.deadlineMs) < BigInt(blockTimestamp) * 1000n) {
    return { ...base, status: "invalid", signer, digest, error: "Avantis intent deadline has expired." };
  }
  const nonce = BigInt(action.nonce);
  const bitmap = await readNonce(signer, nonce >> 8n);
  const nonceUsed = (bitmap & (1n << (nonce & 255n))) !== 0n;
  if (nonceUsed) return { ...base, status: "invalid", signer, digest, nonceUsed, error: "Avantis unordered nonce is already used." };
  if (signer.toLowerCase() === action.trader.toLowerCase()) {
    return { ...base, status: "valid", signer, digest, nonceUsed, delegated: false };
  }
  const [enabled, expiry] = await readDelegation(action.trader, signer);
  if (!enabled || expiry < BigInt(blockTimestamp)) {
    return { ...base, status: "invalid", signer, digest, nonceUsed, delegated: true, delegationExpiry: expiry.toString(), error: "Avantis signer has no active delegation from the trader." };
  }
  return { ...base, status: "valid", signer, digest, nonceUsed, delegated: true, delegationExpiry: expiry.toString() };
}

export async function preflightAvantis(
  transaction: TransactionEnvelope,
  intent: IntentAnalysis,
  rpcUrl: string,
  requestedBlock?: bigint,
): Promise<AvantisPreflight> {
  const fingerprint = transactionFingerprint(transaction);
  const actions = intent.actions.filter((action): action is AvantisAction => action.kind === "avantis");
  if (!actions.length || intent.actions.some((action) => action.kind !== "avantis")) {
    return { transactionFingerprint: fingerprint, status: "invalid", checks: [], error: "Unsupported Avantis operation." };
  }
  const client = createPublicClient({ transport: rpcTransport(rpcUrl) });
  try {
    if (transaction.chainId !== BASE_CHAIN_ID || await client.getChainId() !== BASE_CHAIN_ID) throw new Error("Unsupported RPC chain");
    const block = await client.getBlock(requestedBlock === undefined ? {} : { blockNumber: requestedBlock });
    if (!block.hash || block.number === null) throw new Error("Unconfirmed block");
    const checks: AvantisIntentCheck[] = [];
    for (const action of actions) {
      if (!action.signedIntent) continue;
      checks.push(await verifyIntent(
        action,
        Number(block.timestamp),
        async (signer, word) => client.readContract({ address: BASE_AVANTIS_TRADING_ROUTER, abi: stateAbi, functionName: "nonceBitmap", args: [signer, word], blockNumber: block.number }),
        async (trader, signer) => client.readContract({ address: BASE_AVANTIS_TRADING_ROUTER, abi: stateAbi, functionName: "multipleDelegations", args: [trader, signer], blockNumber: block.number }),
      ));
    }
    if ((await client.getBlock({ blockNumber: block.number })).hash !== block.hash) throw new Error("Block changed");
    const invalid = checks.find((check) => check.status !== "valid");
    return {
      transactionFingerprint: fingerprint, status: invalid ? "invalid" : "ready",
      blockNumber: block.number.toString(), blockHash: block.hash, blockTimestamp: Number(block.timestamp), checks,
      ...(invalid?.error ? { error: invalid.error } : {}),
    };
  } catch {
    return {
      transactionFingerprint: fingerprint, status: "unavailable", checks: [],
      error: "Unable to verify Avantis signature, nonce and delegation at a fixed block.",
    };
  }
}

export function avantisStateMatches(
  intent: IntentAnalysis,
  state: AvantisPreflight | undefined,
  simulation: SimulationResult,
): boolean {
  const signed = intent.actions.filter((action): action is AvantisAction => action.kind === "avantis" && action.signedIntent);
  const fixedBlockMatches = state?.status === "ready" && state.transactionFingerprint === intent.transactionFingerprint &&
    simulation.success && simulation.transactionFingerprint === state.transactionFingerprint &&
    simulation.blockNumber === state.blockNumber && simulation.blockHash === state.blockHash;
  if (!fixedBlockMatches) return false;
  return signed.length === 0 ||
    signed.every((action) => state.checks.some((check) => check.actionIndex === action.index && check.status === "valid"));
}
