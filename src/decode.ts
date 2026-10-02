import {
  BASE_AERODROME_ROUTER,
  BASE_AVANTIS_TRADING_ROUTER,
  BASE_MORPHO,
  BASE_MOONWELL_COMPTROLLER,
  BASE_MOONWELL_MARKETS,
  BASE_UNISWAP_UNIVERSAL_ROUTER,
} from "./contracts.js";
import { decodeAerodromeTransaction } from "./adapters/aerodrome.js";
import { decodeAvantisTransaction } from "./adapters/avantis.js";
import { decodeMorphoTransaction } from "./adapters/morpho.js";
import { decodeMoonwellTransaction } from "./adapters/moonwell.js";
import { decodeUniswapTransaction } from "./adapters/uniswap.js";
import type { IntentAnalysis, TransactionEnvelope } from "./domain.js";

export function decodeTransaction(transaction: TransactionEnvelope): IntentAnalysis {
  const target = transaction.to.toLowerCase();
  if (target === BASE_UNISWAP_UNIVERSAL_ROUTER.toLowerCase()) {
    return decodeUniswapTransaction(transaction);
  }
  if (target === BASE_AERODROME_ROUTER.toLowerCase()) {
    return decodeAerodromeTransaction(transaction);
  }
  if (target === BASE_AVANTIS_TRADING_ROUTER.toLowerCase()) {
    return decodeAvantisTransaction(transaction);
  }
  if (target === BASE_MORPHO.toLowerCase()) {
    return decodeMorphoTransaction(transaction);
  }
  if (
    target === BASE_MOONWELL_COMPTROLLER.toLowerCase() ||
    BASE_MOONWELL_MARKETS.some((market) => market.market.toLowerCase() === target)
  ) {
    return decodeMoonwellTransaction(transaction);
  }
  return {
    schemaVersion: "1.0",
    protocol: "unknown",
    adapter: "none",
    chainId: transaction.chainId,
    sender: transaction.from,
    target: transaction.to,
    nativeValue: transaction.value,
    actions: [
      {
        kind: "unknown",
        index: 0,
        code: Number.parseInt(transaction.data.slice(2, 10), 16),
        reason: `No protocol adapter registered for target ${transaction.to}`,
      },
    ],
    expectedBalanceChanges: [],
    warnings: ["Target contract is not recognized."],
    ...(transaction.source === undefined ? {} : { source: transaction.source }),
  };
}
