import { decodeFunctionData, getAddress, parseAbi } from "viem";
import { BASE_WETH, ZERO_ADDRESS } from "../contracts.js";
import { transactionFingerprint } from "../permit2.js";
import type {
  Address,
  BalanceChange,
  IntentAnalysis,
  SwapAction,
  TransactionEnvelope,
  UnknownAction,
} from "../domain.js";

export const aerodromeAbi = parseAbi([
  "function swapExactTokensForTokens(uint256 amountIn,uint256 amountOutMin,(address from,address to,bool stable,address factory)[] routes,address to,uint256 deadline) returns (uint256[] amounts)",
  "function swapExactETHForTokens(uint256 amountOutMin,(address from,address to,bool stable,address factory)[] routes,address to,uint256 deadline) payable returns (uint256[] amounts)",
  "function swapExactTokensForETH(uint256 amountIn,uint256 amountOutMin,(address from,address to,bool stable,address factory)[] routes,address to,uint256 deadline) returns (uint256[] amounts)",
]);

function address(value: Address): Address {
  return getAddress(value) as Address;
}

function unsupported(transaction: TransactionEnvelope, reason: string): IntentAnalysis {
  const selector = transaction.data.slice(0, 10);
  const action: UnknownAction = {
    kind: "unknown",
    index: 0,
    code: Number.parseInt(selector.slice(2), 16),
    reason,
  };
  return {
    schemaVersion: "1.0",
    protocol: "aerodrome",
    adapter: "aerodrome-router-v1",
    chainId: transaction.chainId,
    sender: transaction.from,
    target: transaction.to,
    nativeValue: transaction.value,
    transactionFingerprint: transactionFingerprint(transaction),
    actions: [action],
    expectedBalanceChanges: [],
    warnings: ["Unsupported or malformed Aerodrome calls are rejected."],
    ...(transaction.source ? { source: transaction.source } : {}),
  };
}

export function decodeAerodromeTransaction(transaction: TransactionEnvelope): IntentAnalysis {
  try {
    const decoded = decodeFunctionData({ abi: aerodromeAbi, data: transaction.data });
    const ethInput = decoded.functionName === "swapExactETHForTokens";
    const ethOutput = decoded.functionName === "swapExactTokensForETH";
    const args = decoded.args;
    const amountIn = ethInput ? BigInt(transaction.value) : args[0] as bigint;
    const amountOutMin = (ethInput ? args[0] : args[1]) as bigint;
    const routes = (ethInput ? args[1] : args[2]) as readonly {
      from: Address;
      to: Address;
      stable: boolean;
      factory: Address;
    }[];
    const rawRecipient = (ethInput ? args[2] : args[3]) as Address;
    const deadline = (ethInput ? args[3] : args[4]) as bigint;
    if (!routes.length) return unsupported(transaction, "Aerodrome route is empty.");
    for (let index = 1; index < routes.length; index += 1) {
      if (routes[index - 1]!.to.toLowerCase() !== routes[index]!.from.toLowerCase()) {
        return unsupported(transaction, "Aerodrome route token continuity is invalid.");
      }
    }
    if (ethInput && routes[0]!.from.toLowerCase() !== BASE_WETH.toLowerCase()) {
      return unsupported(transaction, "Aerodrome native-input route must begin with WETH.");
    }
    if (ethOutput && routes.at(-1)!.to.toLowerCase() !== BASE_WETH.toLowerCase()) {
      return unsupported(transaction, "Aerodrome native-output route must end with WETH.");
    }
    const inputAsset = ethInput ? ZERO_ADDRESS : address(routes[0]!.from);
    const outputAsset = ethOutput ? ZERO_ADDRESS : address(routes.at(-1)!.to);
    const recipient = rawRecipient.toLowerCase() === ZERO_ADDRESS.toLowerCase()
      ? transaction.from : address(rawRecipient);
    const action: SwapAction = {
      kind: "swap",
      index: 0,
      protocolVersion: "aerodrome",
      mode: "exact-input",
      recipient,
      payerIsUser: true,
      route: routes.map((route) => ({
        tokenIn: address(route.from),
        tokenOut: address(route.to),
        stable: route.stable,
        factory: address(route.factory),
      })),
      amountIn: { value: amountIn.toString(), mode: "exact" },
      amountOut: { value: amountOutMin.toString(), mode: "minimum" },
      inputAsset,
      outputAsset,
    };
    const changes: readonly BalanceChange[] = [
      {
        account: "sender",
        asset: inputAsset,
        category: "asset",
        direction: "debit",
        amount: action.amountIn,
        reason: "Aerodrome exact-input amount",
      },
      {
        account: recipient,
        asset: outputAsset,
        category: "asset",
        direction: "credit",
        amount: action.amountOut,
        reason: "Aerodrome minimum output guarantee",
      },
    ];
    return {
      schemaVersion: "1.0",
      protocol: "aerodrome",
      adapter: "aerodrome-router-v1",
      chainId: transaction.chainId,
      sender: transaction.from,
      target: transaction.to,
      nativeValue: transaction.value,
      deadline: deadline.toString(),
      transactionFingerprint: transactionFingerprint(transaction),
      actions: [action],
      expectedBalanceChanges: changes,
      warnings: ["Output is a calldata minimum; realized output depends on pool state."],
      ...(transaction.source ? { source: transaction.source } : {}),
    };
  } catch {
    return unsupported(transaction, `Unsupported Aerodrome selector ${transaction.data.slice(0, 10)}`);
  }
}
