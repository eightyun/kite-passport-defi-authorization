import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { loadPolicy, loadTransaction } from "../src/io.js";
import { createAuthorizationReport } from "../src/report.js";
import { skippedSimulation } from "../src/simulation.js";

const fixtureDirectory = resolve("fixtures/transactions");
const policyPath = resolve("config/policy.example.json");

test("decodes a real Uniswap v3 multi-hop exact-input transaction", async () => {
  const transaction = await loadTransaction(resolve(fixtureDirectory, "uniswap-v3-exact-input.base.json"));
  const policy = await loadPolicy(policyPath);
  const report = createAuthorizationReport(transaction, policy, {
    generatedAt: transaction.source?.timestamp ?? "2026-09-30T17:20:17.000Z",
    nowSeconds: 1_790_788_817,
    simulation: skippedSimulation(),
  });
  const swap = report.intent.actions[0];
  assert.equal(report.finalDecision, "pass");
  assert.equal(report.intent.protocol, "uniswap");
  assert.equal(swap?.kind, "swap");
  if (swap?.kind !== "swap") {
    return;
  }
  assert.equal(swap.protocolVersion, "v3");
  assert.equal(swap.mode, "exact-input");
  assert.equal(swap.amountIn.value, "162000000");
  assert.equal(swap.amountOut.value, "8280307828977075455");
  assert.deepEqual(
    swap.route.map((step) => step.fee),
    [100, 3000],
  );
  assert.equal(swap.route[0]?.tokenIn.toLowerCase(), "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
  assert.equal(swap.route[1]?.tokenOut.toLowerCase(), "0xdcf5130274753c8050ab061b1a1dcbf583f5bfd0");
});

test("decodes a real Uniswap v4 swap and its settlement actions", async () => {
  const transaction = await loadTransaction(resolve(fixtureDirectory, "uniswap-v4-exact-input.base.json"));
  const policy = await loadPolicy(policyPath);
  const report = createAuthorizationReport(transaction, policy, {
    generatedAt: transaction.source?.timestamp ?? "2026-09-30T17:20:45.000Z",
    nowSeconds: 1_790_788_845,
    simulation: skippedSimulation(),
  });
  const swap = report.intent.actions[0];
  assert.equal(report.finalDecision, "pass");
  assert.equal(swap?.kind, "swap");
  if (swap?.kind !== "swap") {
    return;
  }
  assert.equal(swap.protocolVersion, "v4");
  assert.equal(swap.amountIn.value, "334000000000000");
  assert.equal(swap.amountOut.value, "889299");
  assert.equal(swap.recipient, "sender");
  assert.equal(swap.route[0]?.fee, 375);
  assert.equal(swap.route[0]?.tickSpacing, 4);
  assert.equal(swap.route[0]?.hook, "0x0000000000000000000000000000000000000000");
  assert.deepEqual(
    report.intent.actions.slice(1).map((action) => (action.kind === "transfer" ? action.operation : action.kind)),
    ["settle", "take"],
  );
});

test("decodes real Moonwell supply and withdraw transactions", async () => {
  const [supply, withdraw, policy] = await Promise.all([
    loadTransaction(resolve(fixtureDirectory, "moonwell-supply-usdc.base.json")),
    loadTransaction(resolve(fixtureDirectory, "moonwell-withdraw-usdc.base.json")),
    loadPolicy(policyPath),
  ]);
  const supplyReport = createAuthorizationReport(supply, policy, {
    generatedAt: supply.source?.timestamp ?? "2026-09-30T15:47:43.000Z",
    nowSeconds: 1_790_783_263,
    simulation: skippedSimulation(),
  });
  const withdrawReport = createAuthorizationReport(withdraw, policy, {
    generatedAt: withdraw.source?.timestamp ?? "2026-09-30T15:47:49.000Z",
    nowSeconds: 1_790_783_269,
    simulation: skippedSimulation(),
  });
  const supplyAction = supplyReport.intent.actions[0];
  const withdrawAction = withdrawReport.intent.actions[0];
  assert.equal(supplyAction?.kind, "lending");
  assert.equal(withdrawAction?.kind, "lending");
  if (supplyAction?.kind !== "lending" || withdrawAction?.kind !== "lending") {
    return;
  }
  assert.equal(supplyAction.operation, "supply");
  assert.equal(withdrawAction.operation, "withdraw");
  assert.equal(supplyAction.amount?.value, "58413");
  assert.equal(withdrawAction.amount?.value, "58413");
  assert.equal(supplyReport.intent.expectedBalanceChanges[1]?.assetSymbol, "mUSDC");
  assert.equal(withdrawReport.intent.expectedBalanceChanges[1]?.assetSymbol, "USDC");
});

test("retains verifiable provenance for every real transaction vector", async () => {
  const files = [
    "uniswap-v3-exact-input.base.json",
    "uniswap-v4-exact-input.base.json",
    "moonwell-supply-usdc.base.json",
    "moonwell-withdraw-usdc.base.json",
    "uniswap-permit2-usdc.base.json",
  ];
  for (const file of files) {
    const transaction = await loadTransaction(resolve(fixtureDirectory, file));
    assert.equal(transaction.source?.name, "Base Blockscout");
    assert.match(transaction.source?.transactionHash ?? "", /^0x[0-9a-f]{64}$/);
    assert.equal(transaction.source?.observedStatus, "success");
    assert.match(transaction.source?.explorerUrl ?? "", /^https:\/\/base\.blockscout\.com\/tx\/0x/);
  }
});
