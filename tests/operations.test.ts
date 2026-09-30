import assert from "node:assert/strict";
import test from "node:test";
import {
  concatHex,
  encodeAbiParameters,
  encodeFunctionData,
  parseAbi,
  parseAbiParameters,
  toHex,
} from "viem";
import {
  BASE_MOONWELL_COMPTROLLER,
  BASE_MOONWELL_MARKETS,
  BASE_UNISWAP_UNIVERSAL_ROUTER,
  BASE_USDBC,
  BASE_USDC,
  BASE_WETH,
  ZERO_ADDRESS,
} from "../src/contracts.js";
import { decodeTransaction } from "../src/decode.js";
import type { Address, Hex, TransactionEnvelope } from "../src/domain.js";

const sender = "0x2222222222222222222222222222222222222222" as Address;

function universalRouterTransaction(command: Hex, input: Hex): TransactionEnvelope {
  return {
    chainId: 8453,
    from: sender,
    to: BASE_UNISWAP_UNIVERSAL_ROUTER,
    value: "0",
    data: encodeFunctionData({
      abi: parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]),
      functionName: "execute",
      args: [command, [input], 2_000_000_000n],
    }),
  };
}

test("decodes Uniswap v2 exact-output amounts in semantic order", () => {
  const input = encodeAbiParameters(
    parseAbiParameters("address recipient, uint256 amountOut, uint256 amountInMaximum, address[] path, bool payerIsUser"),
    [sender, 100n, 200n, [BASE_USDC, BASE_WETH], true],
  );
  const analysis = decodeTransaction(universalRouterTransaction("0x09", input));
  const swap = analysis.actions[0];
  assert.equal(swap?.kind, "swap");
  if (swap?.kind !== "swap") {
    return;
  }
  assert.equal(swap.protocolVersion, "v2");
  assert.equal(swap.mode, "exact-output");
  assert.deepEqual(swap.amountIn, { value: "200", mode: "maximum" });
  assert.deepEqual(swap.amountOut, { value: "100", mode: "exact" });
});

test("reverses a Uniswap v3 exact-output path into execution order", () => {
  const reversedPath = concatHex([BASE_WETH, toHex(3000, { size: 3 }), BASE_USDC]);
  const input = encodeAbiParameters(
    parseAbiParameters("address recipient, uint256 amountOut, uint256 amountInMaximum, bytes path, bool payerIsUser"),
    [sender, 100n, 200n, reversedPath, true],
  );
  const analysis = decodeTransaction(universalRouterTransaction("0x01", input));
  const swap = analysis.actions[0];
  assert.equal(swap?.kind, "swap");
  if (swap?.kind !== "swap") {
    return;
  }
  assert.equal(swap.route[0]?.tokenIn, BASE_USDC);
  assert.equal(swap.route[0]?.tokenOut, BASE_WETH);
  assert.equal(swap.route[0]?.fee, 3000);
  assert.deepEqual(swap.amountIn, { value: "200", mode: "maximum" });
  assert.deepEqual(swap.amountOut, { value: "100", mode: "exact" });
});

test("decodes a vanilla Uniswap v4 exact-output single-pool swap", () => {
  const swapParams = encodeAbiParameters(
    parseAbiParameters(
      "((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 amountOut, uint128 amountInMaximum, uint256 minHopPriceX36, bytes hookData) params",
    ),
    [
      {
        poolKey: {
          currency0: ZERO_ADDRESS,
          currency1: BASE_USDBC,
          fee: 500,
          tickSpacing: 10,
          hooks: ZERO_ADDRESS,
        },
        zeroForOne: false,
        amountOut: 123n,
        amountInMaximum: 456n,
        minHopPriceX36: 0n,
        hookData: "0x",
      },
    ],
  );
  const v4Input = encodeAbiParameters(parseAbiParameters("bytes actions, bytes[] params"), ["0x08", [swapParams]]);
  const analysis = decodeTransaction(universalRouterTransaction("0x10", v4Input));
  const swap = analysis.actions[0];
  assert.equal(swap?.kind, "swap");
  if (swap?.kind !== "swap") {
    return;
  }
  assert.equal(swap.protocolVersion, "v4");
  assert.equal(swap.route[0]?.tokenIn.toLowerCase(), BASE_USDBC.toLowerCase());
  assert.equal(swap.route[0]?.tokenOut, ZERO_ADDRESS);
  assert.deepEqual(swap.amountIn, { value: "456", mode: "maximum" });
  assert.deepEqual(swap.amountOut, { value: "123", mode: "exact" });
});

function moonwellTransaction(target: Address, data: Hex): TransactionEnvelope {
  return { chainId: 8453, from: sender, to: target, value: "0", data };
}

test("decodes Moonwell borrow and repay-on-behalf operations", () => {
  const market = BASE_MOONWELL_MARKETS[0]!;
  const borrowData = encodeFunctionData({
    abi: parseAbi(["function borrow(uint256 amount)"]),
    functionName: "borrow",
    args: [500n],
  });
  const repayData = encodeFunctionData({
    abi: parseAbi(["function repayBorrowBehalf(address borrower, uint256 amount)"]),
    functionName: "repayBorrowBehalf",
    args: [sender, 300n],
  });
  const borrow = decodeTransaction(moonwellTransaction(market.market, borrowData)).actions[0];
  const repay = decodeTransaction(moonwellTransaction(market.market, repayData)).actions[0];
  assert.equal(borrow?.kind, "lending");
  assert.equal(repay?.kind, "lending");
  if (borrow?.kind !== "lending" || repay?.kind !== "lending") {
    return;
  }
  assert.equal(borrow.operation, "borrow");
  assert.equal(borrow.amount?.value, "500");
  assert.equal(repay.operation, "repay");
  assert.equal(repay.amount?.value, "300");
  assert.equal(repay.beneficiary, sender);
});

test("decodes Moonwell collateral enablement for every requested market", () => {
  const markets = BASE_MOONWELL_MARKETS.map((market) => market.market);
  const data = encodeFunctionData({
    abi: parseAbi(["function enterMarkets(address[] markets) returns (uint256[])"]),
    functionName: "enterMarkets",
    args: [markets],
  });
  const analysis = decodeTransaction(moonwellTransaction(BASE_MOONWELL_COMPTROLLER, data));
  assert.equal(analysis.actions.length, markets.length);
  assert.ok(
    analysis.actions.every(
      (action) => action.kind === "lending" && action.operation === "enable-collateral",
    ),
  );
});

test("returns a rejectable intent for an unregistered target", () => {
  const target = "0x1111111111111111111111111111111111111111" as Address;
  const analysis = decodeTransaction(
    moonwellTransaction(target, "0x123456780000000000000000000000000000000000000000000000000000000000000001"),
  );
  assert.equal(analysis.protocol, "unknown");
  assert.equal(analysis.actions[0]?.kind, "unknown");
});

test("marks Universal Router allow-revert commands as unsupported", () => {
  const input = encodeAbiParameters(
    parseAbiParameters("address recipient, uint256 amountIn, uint256 amountOutMinimum, address[] path, bool payerIsUser"),
    [sender, 100n, 1n, [BASE_USDC, BASE_WETH], true],
  );
  const analysis = decodeTransaction(universalRouterTransaction("0x88", input));
  const action = analysis.actions[0];
  assert.equal(action?.kind, "unknown");
  if (action?.kind === "unknown") {
    assert.match(action.reason, /allow-revert/);
  }
});
