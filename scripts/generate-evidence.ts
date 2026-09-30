import { mkdir, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  Address,
  IntentAnalysis,
  PolicyConfig,
  PolicyDecision,
  PolicyReasonCode,
  SimulationResult,
} from "../src/domain.js";
import { decodeTransaction } from "../src/decode.js";
import { loadPolicy, loadTransaction } from "../src/io.js";
import { evaluatePolicy } from "../src/policy.js";
import { createAuthorizationReport } from "../src/report.js";
import { simulateTransaction } from "../src/simulation.js";

const fixtureDirectory = resolve("fixtures/transactions");
const evidenceDirectory = resolve("evidence");
const reportDirectory = resolve(evidenceDirectory, "reports");
const rpcUrl = process.env.BASE_RPC_URL ?? "https://mainnet.base.org";

interface RejectionEvidence {
  readonly scenario: string;
  readonly expectedCode: PolicyReasonCode;
  readonly outcome: PolicyDecision["outcome"];
  readonly observedCodes: readonly PolicyReasonCode[];
  readonly messages: readonly string[];
}

function successfulSimulation(): SimulationResult {
  return { attempted: true, success: true };
}

function rejectionEvidence(intent: IntentAnalysis, policy: PolicyConfig): readonly RejectionEvidence[] {
  const swap = intent.actions[0];
  if (swap?.kind !== "swap") {
    throw new Error("Expected the Uniswap v4 evidence vector to start with a swap");
  }
  const unknownAddress = "0x1111111111111111111111111111111111111111" as Address;
  const baseNow = 1_790_788_845;
  const scenarios: readonly {
    name: string;
    code: PolicyReasonCode;
    intent: IntentAnalysis;
    policy: PolicyConfig;
    now?: number;
    simulation?: SimulationResult;
  }[] = [
    { name: "unsupported chain", code: "UNSUPPORTED_CHAIN", intent: { ...intent, chainId: 1 }, policy },
    { name: "unauthorized target", code: "UNAUTHORIZED_TARGET", intent: { ...intent, target: unknownAddress }, policy },
    {
      name: "unknown router action",
      code: "UNKNOWN_ACTION",
      intent: { ...intent, actions: [{ kind: "unknown", index: 0, code: 255, reason: "Unknown router action" }] },
      policy,
    },
    {
      name: "unapproved token",
      code: "UNAPPROVED_TOKEN",
      intent: { ...intent, actions: [{ ...swap, route: [{ ...swap.route[0]!, tokenOut: unknownAddress }] }] },
      policy,
    },
    {
      name: "unapproved recipient",
      code: "UNAPPROVED_RECIPIENT",
      intent: { ...intent, actions: [{ ...swap, recipient: unknownAddress }] },
      policy,
    },
    {
      name: "token amount above policy cap",
      code: "AMOUNT_LIMIT_EXCEEDED",
      intent,
      policy: {
        ...policy,
        maximumAmountByToken: {
          ...policy.maximumAmountByToken,
          [swap.route[0]!.tokenIn.toLowerCase()]: "1",
        },
      },
    },
    {
      name: "native value above policy cap",
      code: "NATIVE_VALUE_LIMIT_EXCEEDED",
      intent: { ...intent, nativeValue: "2" },
      policy: { ...policy, maximumNativeValue: "1" },
    },
    {
      name: "expired deadline",
      code: "DEADLINE_EXPIRED",
      intent,
      policy,
      now: Number(intent.deadline) + 1,
    },
    {
      name: "deadline beyond permitted horizon",
      code: "DEADLINE_TOO_FAR",
      intent,
      policy: { ...policy, maximumDeadlineSeconds: 1 },
    },
    {
      name: "zero minimum swap output",
      code: "ZERO_MINIMUM_OUTPUT",
      intent: { ...intent, actions: [{ ...swap, amountOut: { value: "0", mode: "minimum" } }] },
      policy,
    },
    {
      name: "unapproved Uniswap v4 hook",
      code: "V4_HOOK_NOT_ALLOWED",
      intent: { ...intent, actions: [{ ...swap, route: [{ ...swap.route[0]!, hook: unknownAddress }] }] },
      policy,
    },
    {
      name: "dynamic Uniswap v4 fee",
      code: "DYNAMIC_V4_FEE_NOT_ALLOWED",
      intent: { ...intent, actions: [{ ...swap, route: [{ ...swap.route[0]!, dynamicFee: true }] }] },
      policy,
    },
    {
      name: "Moonwell borrowing disabled",
      code: "BORROW_NOT_ALLOWED",
      intent: {
        ...intent,
        protocol: "moonwell",
        actions: [
          {
            kind: "lending",
            index: 0,
            operation: "borrow",
            market: policy.allowedTargets[2]!,
            asset: policy.allowedTokens[2]!,
            amount: { value: "1", mode: "exact" },
            beneficiary: "sender",
          },
        ],
      },
      policy,
    },
    {
      name: "unverified Permit2 authorization",
      code: "UNVERIFIED_AUTHORIZATION",
      intent: {
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
    },
    {
      name: "RPC simulation failure",
      code: "SIMULATION_FAILED",
      intent,
      policy,
      simulation: { attempted: true, success: false, error: "execution reverted" },
    },
  ];

  return scenarios.map((scenario) => {
    const decision = evaluatePolicy(scenario.intent, scenario.policy, {
      nowSeconds: scenario.now ?? baseNow,
      simulation: scenario.simulation ?? successfulSimulation(),
    });
    if (!decision.findings.some((finding) => finding.code === scenario.code)) {
      throw new Error(`Evidence scenario ${scenario.name} did not produce ${scenario.code}`);
    }
    return {
      scenario: scenario.name,
      expectedCode: scenario.code,
      outcome: decision.outcome,
      observedCodes: decision.findings.map((finding) => finding.code),
      messages: decision.findings.map((finding) => finding.message),
    };
  });
}

async function main(): Promise<void> {
  await mkdir(reportDirectory, { recursive: true });
  const policy = await loadPolicy(resolve("config/policy.example.json"));
  const files = (await readdir(fixtureDirectory)).filter((file) => file.endsWith(".json")).sort();
  const summaries: string[] = [];
  let v4Intent: IntentAnalysis | undefined;

  for (const file of files) {
    const transaction = await loadTransaction(resolve(fixtureDirectory, file));
    const simulation = await simulateTransaction(transaction, rpcUrl);
    const evaluationTime = transaction.source?.timestamp ?? new Date().toISOString();
    const report = createAuthorizationReport(transaction, policy, {
      generatedAt: evaluationTime,
      nowSeconds: Math.floor(Date.parse(evaluationTime) / 1000),
      simulation,
    });
    if (!simulation.success || report.finalDecision !== "pass") {
      throw new Error(`${file} did not pass historical preflight`);
    }
    await writeFile(
      resolve(reportDirectory, file.replace(".base.json", ".report.json")),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );
    const operation = report.intent.actions
      .filter((action) => action.kind === "swap" || action.kind === "lending")
      .map((action) => (action.kind === "swap" ? `${action.protocolVersion} ${action.mode}` : action.operation))
      .join(", ");
    summaries.push(
      `| ${file} | ${report.intent.protocol} | ${operation} | ${transaction.source?.transactionHash ?? "n/a"} | pass | pass |`,
    );
    if (file.startsWith("uniswap-v4")) {
      v4Intent = report.intent;
    }
  }

  if (v4Intent === undefined) {
    throw new Error("Missing Uniswap v4 evidence vector");
  }
  const rejections = rejectionEvidence(v4Intent, policy);
  await writeFile(
    resolve(evidenceDirectory, "rejection-tests.json"),
    `${JSON.stringify({ generatedAt: v4Intent.source?.timestamp ?? "2026-09-30T17:20:45.000Z", count: rejections.length, cases: rejections }, null, 2)}\n`,
    "utf8",
  );

  const riskReport = `# Simulation and risk precheck report

Generated from Base mainnet transaction vectors. Each RPC simulation replays the call at the block immediately before the observed transaction.

| Fixture | Protocol | Parsed operation | Transaction | Policy | Historical RPC simulation |
|---|---|---|---|---|---|
${summaries.join("\n")}

## Enforced controls

- Only configured chains, targets, tokens and recipients are accepted.
- Token and native-value limits are checked before execution.
- Expired or excessively distant deadlines are rejected.
- Exact-input swaps with zero minimum output are rejected.
- Unknown Universal Router commands and v4 actions are rejected.
- Universal Router allow-revert commands are rejected by the authorization policy.
- Non-zero Uniswap v4 hooks and dynamic-fee pools are rejected unless explicitly enabled.
- Moonwell borrowing is denied by the example policy.
- Failed RPC simulation is a rejection.

## Balance-change interpretation

- Exact calldata bounds are reported as exact, minimum or maximum amounts.
- Moonwell mToken mint/burn amounts are marked unknown because the exchange rate is state-dependent.
- Uniswap outputs are minimum guarantees; realized output still depends on pool state.

## Limitations

- Permit2 commands are recognized, but the tool does not independently verify EIP-712 signatures.
- Arbitrary Uniswap v4 hooks are outside the supported trust boundary.
- RPC simulation verifies call success at a fixed historical state; it does not guarantee execution against a later state.
- This project does not sign or broadcast transactions and is not production risk control without an independent audit.
`;
  await writeFile(resolve(evidenceDirectory, "simulation-and-risk-precheck.md"), riskReport, "utf8");

  const index = `# Acceptance evidence

This directory contains reproducible evidence for the Passport DeFi authorization acceptance criteria.

## Evidence map

- Real transaction calldata: [../fixtures/transactions](../fixtures/transactions)
- Parsed intent, expected balance changes, policy decision and RPC result: [reports](./reports)
- Policy configuration: [../config/policy.example.json](../config/policy.example.json)
- Fifteen explicit rejection paths: [rejection-tests.json](./rejection-tests.json)
- Simulation and risk precheck: [simulation-and-risk-precheck.md](./simulation-and-risk-precheck.md)
- Automated assertions: [../tests](../tests)

## Reproduce

\`\`\`bash
npm ci
npm run check
npm test
npm run evidence
\`\`\`

Set \`BASE_RPC_URL\` to an archive-capable Base RPC endpoint if the public endpoint is unavailable.
`;
  await writeFile(resolve(evidenceDirectory, "README.md"), index, "utf8");
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
