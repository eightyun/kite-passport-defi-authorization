import {
  decodeAbiParameters,
  getAddress,
  hexToBytes,
  parseAbiParameters,
  sliceHex,
} from "viem";
import {
  BASE_WETH,
  MSG_SENDER_RECIPIENT,
  ROUTER_RECIPIENT,
  ZERO_ADDRESS,
} from "../contracts.js";
import type {
  Address,
  Amount,
  BalanceChange,
  Hex,
  IntentAction,
  IntentAnalysis,
  SwapAction,
  SwapRouteStep,
  TransactionEnvelope,
  TransferAction,
  UnknownAction,
} from "../domain.js";
import { decodePermit2Command, transactionFingerprint } from "../permit2.js";

const EXECUTE_WITH_DEADLINE_SELECTOR = "0x3593564c";
const EXECUTE_SELECTOR = "0x24856bc3";

const COMMAND = {
  V3_SWAP_EXACT_IN: 0x00,
  V3_SWAP_EXACT_OUT: 0x01,
  PERMIT2_TRANSFER_FROM: 0x02,
  PERMIT2_PERMIT_BATCH: 0x03,
  SWEEP: 0x04,
  TRANSFER: 0x05,
  PAY_PORTION: 0x06,
  V2_SWAP_EXACT_IN: 0x08,
  V2_SWAP_EXACT_OUT: 0x09,
  PERMIT2_PERMIT: 0x0a,
  WRAP_ETH: 0x0b,
  UNWRAP_WETH: 0x0c,
  PERMIT2_TRANSFER_FROM_BATCH: 0x0d,
  BALANCE_CHECK_ERC20: 0x0e,
  V4_SWAP: 0x10,
} as const;

const V4_ACTION = {
  SWAP_EXACT_IN_SINGLE: 0x06,
  SWAP_EXACT_IN: 0x07,
  SWAP_EXACT_OUT_SINGLE: 0x08,
  SWAP_EXACT_OUT: 0x09,
  SETTLE: 0x0b,
  SETTLE_ALL: 0x0c,
  TAKE: 0x0e,
  TAKE_ALL: 0x0f,
  SWEEP: 0x14,
  WRAP: 0x15,
  UNWRAP: 0x16,
} as const;

const DYNAMIC_FEE_FLAG = 0x800000;
const CONTRACT_BALANCE = 1n << 255n;

function amount(value: bigint, mode: Amount["mode"]): Amount {
  return { value: value.toString(), mode };
}

function unknownAmount(mode: "all" | "unknown" = "unknown"): Amount {
  return { value: mode, mode };
}

function normalizeAddress(value: Address): Address {
  return getAddress(value) as Address;
}

function recipientLabel(recipient: Address, transaction: TransactionEnvelope): string {
  const normalized = recipient.toLowerCase();
  if (
    normalized === MSG_SENDER_RECIPIENT.toLowerCase() ||
    normalized === transaction.from.toLowerCase()
  ) {
    return "sender";
  }
  if (
    normalized === ROUTER_RECIPIENT.toLowerCase() ||
    normalized === transaction.to.toLowerCase()
  ) {
    return "router";
  }
  return normalizeAddress(recipient);
}

function parseV3Path(path: Hex, reverse: boolean): readonly Address[] {
  const raw = path.slice(2);
  if (raw.length < 40 || (raw.length - 40) % 46 !== 0) {
    throw new Error("Invalid Uniswap v3 path length");
  }

  const tokens: Address[] = [normalizeAddress(`0x${raw.slice(0, 40)}` as Address)];
  for (let offset = 40; offset < raw.length; offset += 46) {
    tokens.push(normalizeAddress(`0x${raw.slice(offset + 6, offset + 46)}` as Address));
  }
  return reverse ? tokens.reverse() : tokens;
}

function parseV3Fees(path: Hex, reverse: boolean): readonly number[] {
  const raw = path.slice(2);
  const fees: number[] = [];
  for (let offset = 40; offset < raw.length; offset += 46) {
    fees.push(Number.parseInt(raw.slice(offset, offset + 6), 16));
  }
  return reverse ? fees.reverse() : fees;
}

function routeFromTokens(tokens: readonly Address[], fees?: readonly number[]): readonly SwapRouteStep[] {
  const steps: SwapRouteStep[] = [];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const tokenIn = tokens[index];
    const tokenOut = tokens[index + 1];
    if (tokenIn === undefined || tokenOut === undefined) {
      throw new Error("Invalid swap route");
    }
    const fee = fees?.[index];
    steps.push({
      tokenIn,
      tokenOut,
      ...(fee === undefined ? {} : { fee }),
    });
  }
  return steps;
}

function decodeV2Swap(
  input: Hex,
  index: number,
  transaction: TransactionEnvelope,
  mode: SwapAction["mode"],
): SwapAction {
  const [recipient, firstAmount, secondAmount, path, payerIsUser] = decodeAbiParameters(
    parseAbiParameters("address recipient, uint256 firstAmount, uint256 secondAmount, address[] path, bool payerIsUser"),
    input,
  );
  const normalizedPath = path.map((token) => normalizeAddress(token));
  const exactInput = mode === "exact-input";
  return {
    kind: "swap",
    index,
    protocolVersion: "v2",
    mode,
    recipient: recipientLabel(recipient, transaction),
    payerIsUser,
    route: routeFromTokens(normalizedPath),
    amountIn: amount(exactInput ? firstAmount : secondAmount, exactInput ? "exact" : "maximum"),
    amountOut: amount(exactInput ? secondAmount : firstAmount, exactInput ? "minimum" : "exact"),
  };
}

function decodeV3Swap(
  input: Hex,
  index: number,
  transaction: TransactionEnvelope,
  mode: SwapAction["mode"],
): SwapAction {
  const [recipient, firstAmount, secondAmount, path, payerIsUser] = decodeAbiParameters(
    parseAbiParameters("address recipient, uint256 firstAmount, uint256 secondAmount, bytes path, bool payerIsUser"),
    input,
  );
  const exactOutput = mode === "exact-output";
  const tokens = parseV3Path(path, exactOutput);
  const fees = parseV3Fees(path, exactOutput);
  return {
    kind: "swap",
    index,
    protocolVersion: "v3",
    mode,
    recipient: recipientLabel(recipient, transaction),
    payerIsUser,
    route: routeFromTokens(tokens, fees),
    amountIn: amount(exactOutput ? secondAmount : firstAmount, exactOutput ? "maximum" : "exact"),
    amountOut: amount(exactOutput ? firstAmount : secondAmount, exactOutput ? "exact" : "minimum"),
  };
}

function v4Step(
  tokenIn: Address,
  tokenOut: Address,
  fee: number,
  tickSpacing: number,
  hook: Address,
): SwapRouteStep {
  return {
    tokenIn: normalizeAddress(tokenIn),
    tokenOut: normalizeAddress(tokenOut),
    fee,
    tickSpacing,
    hook: normalizeAddress(hook),
    dynamicFee: (fee & DYNAMIC_FEE_FLAG) !== 0,
  };
}

function decodeV4SwapAction(input: Hex, actionCode: number, index: number): SwapAction | UnknownAction {
  if (actionCode === V4_ACTION.SWAP_EXACT_IN_SINGLE || actionCode === V4_ACTION.SWAP_EXACT_OUT_SINGLE) {
    const [params] = decodeAbiParameters(
      parseAbiParameters(
        "((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 amountSpecified, uint128 amountLimit, uint256 minHopPriceX36, bytes hookData) params",
      ),
      input,
    );
    const exactInput = actionCode === V4_ACTION.SWAP_EXACT_IN_SINGLE;
    const tokenIn = params.zeroForOne ? params.poolKey.currency0 : params.poolKey.currency1;
    const tokenOut = params.zeroForOne ? params.poolKey.currency1 : params.poolKey.currency0;
    return {
      kind: "swap",
      index,
      protocolVersion: "v4",
      mode: exactInput ? "exact-input" : "exact-output",
      recipient: "settlement",
      payerIsUser: true,
      route: [
        v4Step(
          tokenIn,
          tokenOut,
          params.poolKey.fee,
          params.poolKey.tickSpacing,
          params.poolKey.hooks,
        ),
      ],
      amountIn: amount(
        exactInput ? params.amountSpecified : params.amountLimit,
        exactInput ? "exact" : "maximum",
      ),
      amountOut: amount(
        exactInput ? params.amountLimit : params.amountSpecified,
        exactInput ? "minimum" : "exact",
      ),
    };
  }

  if (actionCode === V4_ACTION.SWAP_EXACT_IN || actionCode === V4_ACTION.SWAP_EXACT_OUT) {
    const [params] = decodeAbiParameters(
      parseAbiParameters(
        "(address currency, (address intermediateCurrency, uint24 fee, int24 tickSpacing, address hooks, bytes hookData)[] path, uint256[] minHopPriceX36, uint128 amountSpecified, uint128 amountLimit) params",
      ),
      input,
    );
    const exactInput = actionCode === V4_ACTION.SWAP_EXACT_IN;
    const orderedCurrencies = [
      normalizeAddress(params.currency),
      ...params.path.map((step) => normalizeAddress(step.intermediateCurrency)),
    ];
    const currencies = exactInput ? orderedCurrencies : orderedCurrencies.reverse();
    const path = exactInput ? params.path : [...params.path].reverse();
    const route = path.map((step, routeIndex) => {
      const tokenIn = currencies[routeIndex];
      const tokenOut = currencies[routeIndex + 1];
      if (tokenIn === undefined || tokenOut === undefined) {
        throw new Error("Invalid Uniswap v4 route");
      }
      return v4Step(tokenIn, tokenOut, step.fee, step.tickSpacing, step.hooks);
    });
    return {
      kind: "swap",
      index,
      protocolVersion: "v4",
      mode: exactInput ? "exact-input" : "exact-output",
      recipient: "settlement",
      payerIsUser: true,
      route,
      amountIn: amount(
        exactInput ? params.amountSpecified : params.amountLimit,
        exactInput ? "exact" : "maximum",
      ),
      amountOut: amount(
        exactInput ? params.amountLimit : params.amountSpecified,
        exactInput ? "minimum" : "exact",
      ),
    };
  }

  return {
    kind: "unknown",
    index,
    code: actionCode,
    reason: `Unsupported Uniswap v4 action 0x${actionCode.toString(16).padStart(2, "0")}`,
  };
}

function decodeV4Settlement(
  input: Hex,
  actionCode: number,
  index: number,
  transaction: TransactionEnvelope,
): TransferAction | UnknownAction {
  if (actionCode === V4_ACTION.SETTLE) {
    const [asset, value, payerIsUser] = decodeAbiParameters(
      parseAbiParameters("address asset, uint256 amount, bool payerIsUser"),
      input,
    );
    return {
      kind: "transfer",
      index,
      operation: "settle",
      asset: normalizeAddress(asset),
      recipient: payerIsUser ? "sender" : "router",
      amount: value === 0n ? unknownAmount("all") : amount(value, "exact"),
    };
  }
  if (actionCode === V4_ACTION.SETTLE_ALL) {
    const [asset, value] = decodeAbiParameters(parseAbiParameters("address asset, uint256 maxAmount"), input);
    return {
      kind: "transfer",
      index,
      operation: "settle",
      asset: normalizeAddress(asset),
      recipient: "sender",
      amount: amount(value, "maximum"),
    };
  }
  if (actionCode === V4_ACTION.TAKE) {
    const [asset, recipient, value] = decodeAbiParameters(
      parseAbiParameters("address asset, address recipient, uint256 amount"),
      input,
    );
    return {
      kind: "transfer",
      index,
      operation: "take",
      asset: normalizeAddress(asset),
      recipient: recipientLabel(recipient, transaction),
      amount: value === 0n ? unknownAmount("all") : amount(value, "exact"),
    };
  }
  if (actionCode === V4_ACTION.TAKE_ALL) {
    const [asset, minimum] = decodeAbiParameters(
      parseAbiParameters("address asset, uint256 minimumAmount"),
      input,
    );
    return {
      kind: "transfer",
      index,
      operation: "take",
      asset: normalizeAddress(asset),
      recipient: "sender",
      amount: amount(minimum, "minimum"),
    };
  }
  if (actionCode === V4_ACTION.SWEEP) {
    const [asset, recipient] = decodeAbiParameters(
      parseAbiParameters("address asset, address recipient"),
      input,
    );
    return {
      kind: "transfer",
      index,
      operation: "sweep",
      asset: normalizeAddress(asset),
      recipient: recipientLabel(recipient, transaction),
      amount: unknownAmount("all"),
    };
  }
  if (actionCode === V4_ACTION.WRAP || actionCode === V4_ACTION.UNWRAP) {
    const [value] = decodeAbiParameters(parseAbiParameters("uint256 amount"), input);
    return {
      kind: "transfer",
      index,
      operation: actionCode === V4_ACTION.WRAP ? "wrap-native" : "unwrap-native",
      amount: amount(value, "exact"),
    };
  }
  return {
    kind: "unknown",
    index,
    code: actionCode,
    reason: `Unsupported Uniswap v4 settlement action 0x${actionCode.toString(16).padStart(2, "0")}`,
  };
}

function decodeV4(input: Hex, commandIndex: number, transaction: TransactionEnvelope): readonly IntentAction[] {
  const [actionBytes, params] = decodeAbiParameters(
    parseAbiParameters("bytes actions, bytes[] params"),
    input,
  );
  const actionCodes = [...hexToBytes(actionBytes)];
  if (actionCodes.length !== params.length) {
    return [
      {
        kind: "unknown",
        index: commandIndex,
        code: COMMAND.V4_SWAP,
        reason: "Uniswap v4 action and parameter counts differ",
      },
    ];
  }

  const decodedActions = actionCodes.map((actionCode, nestedIndex) => {
    const actionInput = params[nestedIndex];
    if (actionInput === undefined) {
      throw new Error("Missing Uniswap v4 action input");
    }
    const index = commandIndex * 100 + nestedIndex;
    if (
      actionCode === V4_ACTION.SWAP_EXACT_IN_SINGLE ||
      actionCode === V4_ACTION.SWAP_EXACT_IN ||
      actionCode === V4_ACTION.SWAP_EXACT_OUT_SINGLE ||
      actionCode === V4_ACTION.SWAP_EXACT_OUT
    ) {
      return decodeV4SwapAction(actionInput, actionCode, index);
    }
    return decodeV4Settlement(actionInput, actionCode, index, transaction);
  });
  const settlement = decodedActions.find(
    (action) => action.kind === "transfer" && action.operation === "settle",
  );
  const take = decodedActions.find(
    (action) => action.kind === "transfer" && action.operation === "take",
  );
  return decodedActions.map((action) => {
    if (action.kind !== "swap") {
      return action;
    }
    return {
      ...action,
      payerIsUser: settlement?.kind === "transfer" && settlement.recipient === "sender",
      recipient:
        take?.kind === "transfer" && take.recipient !== undefined ? take.recipient : action.recipient,
    };
  });
}

function decodeTransferCommand(
  command: number,
  input: Hex,
  index: number,
  transaction: TransactionEnvelope,
): TransferAction | UnknownAction {
  if (command === COMMAND.WRAP_ETH || command === COMMAND.UNWRAP_WETH) {
    const [recipient, value] = decodeAbiParameters(
      parseAbiParameters("address recipient, uint256 amountMinimum"),
      input,
    );
    return {
      kind: "transfer",
      index,
      operation: command === COMMAND.WRAP_ETH ? "wrap-native" : "unwrap-native",
      recipient: recipientLabel(recipient, transaction),
      amount: command === COMMAND.WRAP_ETH
        ? value === CONTRACT_BALANCE ? unknownAmount("all") : amount(value, "exact")
        : amount(value, "minimum"),
    };
  }
  if (command === COMMAND.SWEEP || command === COMMAND.TRANSFER) {
    const [asset, recipient, value] = decodeAbiParameters(
      parseAbiParameters("address asset, address recipient, uint256 amount"),
      input,
    );
    return {
      kind: "transfer",
      index,
      operation: command === COMMAND.SWEEP ? "sweep" : "transfer",
      asset: normalizeAddress(asset),
      recipient: recipientLabel(recipient, transaction),
      amount: command === COMMAND.SWEEP ? amount(value, "minimum") : amount(value, "exact"),
    };
  }
  return {
    kind: "unknown",
    index,
    code: command,
    reason: `Unsupported Universal Router transfer command 0x${command.toString(16).padStart(2, "0")}`,
  };
}

function decodeCommand(
  commandByte: number,
  input: Hex,
  index: number,
  transaction: TransactionEnvelope,
): readonly IntentAction[] {
  if ((commandByte & 0x80) !== 0) {
    return [
      {
        kind: "unknown",
        index,
        code: commandByte,
        reason: "Universal Router allow-revert commands are outside the supported authorization boundary",
      },
    ];
  }
  const command = commandByte & 0x7f;
  if (command === COMMAND.V2_SWAP_EXACT_IN) {
    return [decodeV2Swap(input, index, transaction, "exact-input")];
  }
  if (command === COMMAND.V2_SWAP_EXACT_OUT) {
    return [decodeV2Swap(input, index, transaction, "exact-output")];
  }
  if (command === COMMAND.V3_SWAP_EXACT_IN) {
    return [decodeV3Swap(input, index, transaction, "exact-input")];
  }
  if (command === COMMAND.V3_SWAP_EXACT_OUT) {
    return [decodeV3Swap(input, index, transaction, "exact-output")];
  }
  if (command === COMMAND.V4_SWAP) {
    return decodeV4(input, index, transaction);
  }
  if (
    command === COMMAND.PERMIT2_TRANSFER_FROM ||
    command === COMMAND.PERMIT2_PERMIT_BATCH ||
    command === COMMAND.PERMIT2_PERMIT ||
    command === COMMAND.PERMIT2_TRANSFER_FROM_BATCH
  ) {
    return [decodePermit2Command(command, input, index, transaction)];
  }
  if (
    command === COMMAND.SWEEP ||
    command === COMMAND.TRANSFER ||
    command === COMMAND.WRAP_ETH ||
    command === COMMAND.UNWRAP_WETH
  ) {
    return [decodeTransferCommand(command, input, index, transaction)];
  }
  return [
    {
      kind: "unknown",
      index,
      code: command,
      reason: `Unsupported Universal Router command 0x${command.toString(16).padStart(2, "0")}`,
    },
  ];
}

function buildBalanceChanges(actions: readonly IntentAction[]): readonly BalanceChange[] {
  const changes: BalanceChange[] = [];
  for (const action of actions) {
    if (action.kind === "authorization" && action.transfers) {
      for (const transfer of action.transfers) {
        changes.push({
          account: transfer.from, asset: transfer.token, category: "asset", direction: "debit",
          amount: amount(BigInt(transfer.amount), "exact"), reason: "Explicit Permit2 transfer debit",
        }, {
          account: transfer.to, asset: transfer.token, category: "asset", direction: "credit",
          amount: amount(BigInt(transfer.amount), "exact"), reason: "Explicit Permit2 transfer credit",
        });
      }
    }
    if (action.kind === "transfer") {
      const recipient = action.recipient ?? "settlement";
      if (action.operation === "wrap-native") {
        changes.push({
          account: action.recipient === undefined ? "settlement" : "router",
          asset: ZERO_ADDRESS,
          category: "asset",
          direction: "debit",
          amount: action.amount,
          reason: "Native currency wrapped into WETH",
        }, {
          account: recipient,
          asset: BASE_WETH,
          category: "asset",
          direction: "credit",
          amount: action.amount,
          reason: "WETH received from native wrapping",
        });
      } else if (action.operation === "unwrap-native") {
        changes.push({
          account: action.recipient === undefined ? "settlement" : "router",
          asset: BASE_WETH,
          category: "asset",
          direction: "debit",
          amount: action.amount,
          reason: "WETH unwrapped into native currency",
        }, {
          account: recipient,
          asset: ZERO_ADDRESS,
          category: "asset",
          direction: "credit",
          amount: action.amount,
          reason: "Native currency received from WETH unwrapping",
        });
      } else if (action.asset !== undefined) {
        const source = action.operation === "settle"
          ? recipient
          : action.operation === "take" ? "settlement" : "router";
        const destination = action.operation === "settle" ? "settlement" : recipient;
        changes.push({
          account: source,
          asset: action.asset,
          category: "asset",
          direction: "debit",
          amount: action.amount,
          reason: `${action.operation} source balance`,
        }, {
          account: destination,
          asset: action.asset,
          category: "asset",
          direction: "credit",
          amount: action.amount,
          reason: `${action.operation} destination balance`,
        });
      }
    }
    if (action.kind !== "swap" || action.route.length === 0) {
      continue;
    }
    const first = action.route[0];
    const last = action.route[action.route.length - 1];
    if (first === undefined || last === undefined) {
      continue;
    }
    changes.push({
      account: action.payerIsUser ? "sender" : "router",
      asset: first.tokenIn,
      category: "asset",
      direction: "debit",
      amount: action.amountIn,
      reason: `${action.protocolVersion} ${action.mode} swap input`,
    });
    changes.push({
      account: action.recipient,
      asset: last.tokenOut,
      category: "asset",
      direction: "credit",
      amount: action.amountOut,
      reason: `${action.protocolVersion} ${action.mode} swap output`,
    });
  }
  return changes;
}

export function decodeUniswapTransaction(transaction: TransactionEnvelope): IntentAnalysis {
  const selector = transaction.data.slice(0, 10).toLowerCase();
  const payload = sliceHex(transaction.data, 4);
  let commands: Hex;
  let inputs: readonly Hex[];
  let deadline: bigint | undefined;

  if (selector === EXECUTE_WITH_DEADLINE_SELECTOR) {
    [commands, inputs, deadline] = decodeAbiParameters(
      parseAbiParameters("bytes commands, bytes[] inputs, uint256 deadline"),
      payload,
    );
  } else if (selector === EXECUTE_SELECTOR) {
    [commands, inputs] = decodeAbiParameters(parseAbiParameters("bytes commands, bytes[] inputs"), payload);
  } else {
    throw new Error(`Unsupported Universal Router selector ${selector}`);
  }

  const commandBytes = [...hexToBytes(commands)];
  if (commandBytes.length !== inputs.length) {
    throw new Error("Universal Router command and input counts differ");
  }
  const actions = commandBytes.flatMap((command, index) => {
    const input = inputs[index];
    if (input === undefined) {
      throw new Error("Missing Universal Router command input");
    }
    return decodeCommand(command, input, index, transaction);
  });

  const warnings: string[] = [];
  if (actions.some((action) => action.kind === "authorization" && !action.decoded)) {
    warnings.push("Permit2 authorization could not be decoded.");
  }
  if (actions.some((action) => action.kind === "swap" && action.protocolVersion === "v4")) {
    warnings.push("Uniswap v4 output depends on PoolManager state and any configured hook behavior.");
  }

  return {
    schemaVersion: "1.0",
    protocol: "uniswap",
    adapter: "uniswap-universal-router-v2.1",
    chainId: transaction.chainId,
    sender: transaction.from,
    target: transaction.to,
    nativeValue: transaction.value,
    transactionFingerprint: transactionFingerprint(transaction),
    ...(deadline === undefined ? {} : { deadline: deadline.toString() }),
    actions,
    expectedBalanceChanges: buildBalanceChanges(actions),
    warnings,
    ...(transaction.source === undefined ? {} : { source: transaction.source }),
  };
}

export function nativeCurrencyAddress(): Address {
  return ZERO_ADDRESS;
}
