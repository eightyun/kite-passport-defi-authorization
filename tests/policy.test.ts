import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import type {
  Address,
  IntentAnalysis,
  PolicyConfig,
  PolicyReasonCode,
  SimulationResult,
} from "../src/domain.js";
import { decodeTransaction } from "../src/decode.js";
import { loadPolicy, loadTransaction } from "../src/io.js";
import { evaluatePolicy } from "../src/policy.js";
import { skippedSimulation } from "../src/simulation.js";

const nowSeconds = 1_790_788_845;
const successSimulation: SimulationResult = { attempted: true, success: true };

async function base(): Promise<{ intent: IntentAnalysis; policy: PolicyConfig }> {
  const [transaction, policy] = await Promise.all([
    loadTransaction(resolve("fixtures/transactions/uniswap-v4-exact-input.base.json")),
    loadPolicy(resolve("config/policy.example.json")),
  ]);
  return { intent: decodeTransaction(transaction), policy };
}

function expectCode(
  intent: IntentAnalysis,
  policy: PolicyConfig,
  code: PolicyReasonCode,
  simulation: SimulationResult = successSimulation,
  now = nowSeconds,
): void {
  const decision = evaluatePolicy(intent, policy, { nowSeconds: now, simulation });
  assert.equal(decision.outcome, "reject");
  assert.ok(decision.findings.some((finding) => finding.code === code), `missing ${code}`);
}

test("passes an allowed vanilla Uniswap v4 transaction", async () => {
  const { intent, policy } = await base();
  const decision = evaluatePolicy(intent, policy, { nowSeconds, simulation: successSimulation });
  assert.deepEqual(decision, { outcome: "pass", findings: [] });
});

test("covers explicit policy rejection paths", async (context) => {
  const { intent, policy } = await base();
  const swap = intent.actions[0];
  assert.equal(swap?.kind, "swap");
  if (swap?.kind !== "swap") {
    return;
  }
  const unknownAddress = "0x1111111111111111111111111111111111111111" as Address;

  await context.test("unsupported chain", () => {
    expectCode({ ...intent, chainId: 1 }, policy, "UNSUPPORTED_CHAIN");
  });
  await context.test("unauthorized target", () => {
    expectCode({ ...intent, target: unknownAddress }, policy, "UNAUTHORIZED_TARGET");
  });
  await context.test("unknown action", () => {
    expectCode(
      { ...intent, actions: [{ kind: "unknown", index: 0, code: 255, reason: "unknown" }] },
      policy,
      "UNKNOWN_ACTION",
    );
  });
  await context.test("unapproved token", () => {
    const route = [{ ...swap.route[0]!, tokenOut: unknownAddress }];
    expectCode({ ...intent, actions: [{ ...swap, route }] }, policy, "UNAPPROVED_TOKEN");
  });
  await context.test("unapproved recipient", () => {
    expectCode(
      { ...intent, actions: [{ ...swap, recipient: unknownAddress }] },
      policy,
      "UNAPPROVED_RECIPIENT",
    );
  });
  await context.test("amount limit", () => {
    const token = swap.route[0]!.tokenIn.toLowerCase();
    expectCode(
      intent,
      { ...policy, maximumAmountByToken: { ...policy.maximumAmountByToken, [token]: "1" } },
      "AMOUNT_LIMIT_EXCEEDED",
    );
  });
  await context.test("native value limit", () => {
    expectCode({ ...intent, nativeValue: "2" }, { ...policy, maximumNativeValue: "1" }, "NATIVE_VALUE_LIMIT_EXCEEDED");
  });
  await context.test("expired deadline", () => {
    expectCode(intent, policy, "DEADLINE_EXPIRED", successSimulation, Number(intent.deadline) + 1);
  });
  await context.test("deadline too far", () => {
    expectCode(intent, { ...policy, maximumDeadlineSeconds: 1 }, "DEADLINE_TOO_FAR");
  });
  await context.test("zero minimum output", () => {
    expectCode(
      { ...intent, actions: [{ ...swap, amountOut: { value: "0", mode: "minimum" } }] },
      policy,
      "ZERO_MINIMUM_OUTPUT",
    );
  });
  await context.test("unapproved v4 hook", () => {
    const route = [{ ...swap.route[0]!, hook: unknownAddress }];
    expectCode({ ...intent, actions: [{ ...swap, route }] }, policy, "V4_HOOK_NOT_ALLOWED");
  });
  await context.test("dynamic v4 fee", () => {
    const route = [{ ...swap.route[0]!, dynamicFee: true }];
    expectCode({ ...intent, actions: [{ ...swap, route }] }, policy, "DYNAMIC_V4_FEE_NOT_ALLOWED");
  });
  await context.test("borrow disabled", () => {
    const { deadline: _deadline, ...intentWithoutDeadline } = intent;
    const action = {
      kind: "lending" as const,
      index: 0,
      operation: "borrow" as const,
      market: policy.allowedTargets[2]!,
      asset: policy.allowedTokens[2]!,
      amount: { value: "1", mode: "exact" as const },
      beneficiary: "sender",
    };
    expectCode({ ...intentWithoutDeadline, protocol: "moonwell", actions: [action] }, policy, "BORROW_NOT_ALLOWED");
  });
  await context.test("unverified Permit2 authorization", () => {
    expectCode(
      {
        ...intent,
        actions: [
          {
            kind: "authorization",
            index: 0,
            operation: "permit2-permit",
            decoded: false,
          },
        ],
      },
      policy,
      "UNVERIFIED_AUTHORIZATION",
    );
  });
  await context.test("failed simulation", () => {
    expectCode(intent, policy, "SIMULATION_FAILED", {
      attempted: true,
      success: false,
      error: "execution reverted",
    });
  });
});

test("requires review when mandatory simulation was not attempted", async () => {
  const { intent, policy } = await base();
  const decision = evaluatePolicy(intent, { ...policy, requireSimulation: true }, {
    nowSeconds,
    simulation: skippedSimulation(),
  });
  assert.equal(decision.outcome, "review");
  assert.equal(decision.findings[0]?.code, "SIMULATION_REQUIRED");
});
