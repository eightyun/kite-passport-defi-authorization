import { readFile } from "node:fs/promises";
import { getAddress, isAddress, isHex } from "viem";
import type {
  Address,
  Hex,
  PolicyConfig,
  TransactionEnvelope,
  TransactionSource,
} from "./domain.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string`);
  }
  return value;
}

function requiredNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} must be a finite number`);
  }
  return value;
}

function requiredBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean`);
  }
  return value;
}

function address(value: string, field: string): Address {
  if (!isAddress(value)) {
    throw new Error(`${field} must be an EVM address`);
  }
  return getAddress(value) as Address;
}

function addressArray(record: Record<string, unknown>, key: string): readonly Address[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    throw new Error(`${key} must be an address array`);
  }
  return value.map((item, index) => {
    if (typeof item !== "string") {
      throw new Error(`${key}[${index}] must be an address`);
    }
    return address(item, `${key}[${index}]`);
  });
}

function hexArray(record: Record<string, unknown>, key: string): readonly Hex[] {
  const value = record[key];
  if (!Array.isArray(value)) throw new Error(`${key} must be a hex array`);
  return value.map((item, index) => {
    if (typeof item !== "string" || !isHex(item) || item.length !== 66) {
      throw new Error(`${key}[${index}] must be a 32-byte hex value`);
    }
    return item as Hex;
  });
}

function parseSource(value: unknown): TransactionSource | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error("source must be an object");
  }
  const hash = requiredString(value, "transactionHash");
  if (!isHex(hash) || hash.length !== 66) {
    throw new Error("source.transactionHash must be a 32-byte hex value");
  }
  const observedStatus = requiredString(value, "observedStatus");
  if (observedStatus !== "success" && observedStatus !== "failure") {
    throw new Error("source.observedStatus must be success or failure");
  }
  return {
    name: requiredString(value, "name"),
    transactionHash: hash as Hex,
    explorerUrl: requiredString(value, "explorerUrl"),
    blockNumber: requiredNumber(value, "blockNumber"),
    timestamp: requiredString(value, "timestamp"),
    observedStatus,
  };
}

export function parseTransaction(value: unknown): TransactionEnvelope {
  if (!isRecord(value)) {
    throw new Error("transaction must be an object");
  }
  const data = requiredString(value, "data");
  if (!isHex(data) || data.length < 10) {
    throw new Error("data must contain an EVM function selector");
  }
  const source = parseSource(value.source);
  return {
    chainId: requiredNumber(value, "chainId"),
    from: address(requiredString(value, "from"), "from"),
    to: address(requiredString(value, "to"), "to"),
    data: data as Hex,
    value: requiredString(value, "value"),
    ...(source === undefined ? {} : { source }),
  };
}

export function parsePolicy(value: unknown): PolicyConfig {
  if (!isRecord(value)) {
    throw new Error("policy must be an object");
  }
  const version = requiredString(value, "version");
  if (version !== "1") {
    throw new Error(`Unsupported policy version ${version}`);
  }
  const chainIds = value.allowedChainIds;
  if (!Array.isArray(chainIds) || chainIds.some((chainId) => typeof chainId !== "number")) {
    throw new Error("allowedChainIds must be a number array");
  }
  const rawLimits = value.maximumAmountByToken;
  if (!isRecord(rawLimits)) {
    throw new Error("maximumAmountByToken must be an object");
  }
  const limits: Record<string, string> = {};
  for (const [token, limit] of Object.entries(rawLimits)) {
    if (!isAddress(token) || typeof limit !== "string" || !/^\d+$/.test(limit)) {
      throw new Error("maximumAmountByToken must map token addresses to integer strings");
    }
    limits[token.toLowerCase()] = limit;
  }
  const maximumNativeValue = requiredString(value, "maximumNativeValue");
  if (!/^\d+$/.test(maximumNativeValue)) {
    throw new Error("maximumNativeValue must be an integer string");
  }
  const permit2Durations: { maximumPermit2ExpirationSeconds?: number; maximumPermit2SignatureDeadlineSeconds?: number } = {};
  for (const key of ["maximumPermit2ExpirationSeconds", "maximumPermit2SignatureDeadlineSeconds"] as const) {
    if (value[key] !== undefined) {
      const duration = requiredNumber(value, key);
      if (!Number.isSafeInteger(duration) || duration < 0) throw new Error(`${key} must be a non-negative safe integer`);
      permit2Durations[key] = duration;
    }
  }
  return {
    version: "1",
    allowedChainIds: chainIds,
    allowedTargets: addressArray(value, "allowedTargets"),
    allowedTokens: addressArray(value, "allowedTokens"),
    allowedRecipients: addressArray(value, "allowedRecipients"),
    allowedV4Hooks: addressArray(value, "allowedV4Hooks"),
    allowedAerodromeFactories: value.allowedAerodromeFactories === undefined
      ? [] : addressArray(value, "allowedAerodromeFactories"),
    allowedMorphoMarkets: value.allowedMorphoMarkets === undefined
      ? [] : hexArray(value, "allowedMorphoMarkets"),
    maximumAmountByToken: limits,
    maximumNativeValue,
    maximumDeadlineSeconds: requiredNumber(value, "maximumDeadlineSeconds"),
    allowBorrow: requiredBoolean(value, "allowBorrow"),
    allowDynamicV4Fee: requiredBoolean(value, "allowDynamicV4Fee"),
    requireSimulation: requiredBoolean(value, "requireSimulation"),
    ...permit2Durations,
  };
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

export async function loadTransaction(path: string): Promise<TransactionEnvelope> {
  return parseTransaction(await readJson(path));
}

export async function loadPolicy(path: string): Promise<PolicyConfig> {
  return parsePolicy(await readJson(path));
}
