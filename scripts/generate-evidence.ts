import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import type {
  Address,
  AuthorizationReport,
  IntentAnalysis,
  PolicyConfig,
  PolicyDecision,
  PolicyReasonCode,
  SimulationResult,
} from "../src/domain.js";
import { decodeTransaction } from "../src/decode.js";
import { loadPolicy, loadTransaction } from "../src/io.js";
import { evaluatePolicy } from "../src/policy.js";
import { analyzeTransaction } from "../src/report.js";

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

interface CoverageManifest {
  readonly schemaVersion: "1.0";
  readonly chainId: number;
  readonly vectors: readonly {
    readonly fixture: string;
    readonly operations: readonly string[];
    readonly expectedDecision: PolicyDecision["outcome"];
    readonly expectedSimulation: "pass" | "reject";
  }[];
  readonly deterministicOnly: readonly {
    readonly operation: string;
    readonly test: string;
    readonly reason: string;
  }[];
}

function successfulSimulation(): SimulationResult {
  return { attempted: true, success: true };
}

function retryableReport(report: AuthorizationReport): boolean {
  return report.simulation.error === "RPC simulation failed, reverted, or returned data from the wrong chain." ||
    report.moonwell?.status === "unavailable" || report.morpho?.status === "unavailable" ||
    report.permit2?.checks.some((check) => check.status === "unavailable") === true;
}

async function analyzeWithRetry(
  transaction: Parameters<typeof analyzeTransaction>[0],
  policy: PolicyConfig,
  options: Parameters<typeof analyzeTransaction>[2],
): Promise<AuthorizationReport> {
  let report = await analyzeTransaction(transaction, policy, options);
  for (let attempt = 1; attempt < 3 && retryableReport(report); attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 1_000));
    report = await analyzeTransaction(transaction, policy, options);
  }
  return report;
}

function rejectionEvidence(
  intent: IntentAnalysis,
  aerodromeIntent: IntentAnalysis,
  morphoIntent: IntentAnalysis,
  policy: PolicyConfig,
): readonly RejectionEvidence[] {
  const swap = intent.actions[0];
  if (swap?.kind !== "swap") {
    throw new Error("Expected the Uniswap v4 evidence vector to start with a swap");
  }
  const unknownAddress = "0x1111111111111111111111111111111111111111" as Address;
  const aerodromeSwap = aerodromeIntent.actions[0];
  const morphoAction = morphoIntent.actions[0];
  if (aerodromeSwap?.kind !== "swap" || morphoAction?.kind !== "morpho") {
    throw new Error("Expected Aerodrome and Morpho evidence vectors");
  }
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
    {
      name: "unapproved Aerodrome factory",
      code: "AERODROME_FACTORY_NOT_ALLOWED",
      intent: { ...aerodromeIntent, actions: [{ ...aerodromeSwap, route: [{ ...aerodromeSwap.route[0]!, factory: unknownAddress }] }] },
      policy,
    },
    {
      name: "unapproved Morpho market",
      code: "MORPHO_MARKET_NOT_ALLOWED",
      intent: { ...morphoIntent, actions: [{ ...morphoAction, marketId: `0x${"11".repeat(32)}` }] },
      policy,
    },
    {
      name: "Morpho callback data",
      code: "MORPHO_CALLBACK_NOT_ALLOWED",
      intent: { ...morphoIntent, actions: [{ ...morphoAction, callbackData: "0x01" }] },
      policy,
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
  const coverage = JSON.parse(
    await readFile(resolve("fixtures/operation-coverage.json"), "utf8"),
  ) as CoverageManifest;
  const expectations = new Map(coverage.vectors.map((vector) => [vector.fixture, vector]));
  if (coverage.chainId !== 8453 || coverage.schemaVersion !== "1.0" ||
      files.some((file) => !expectations.has(file)) || expectations.size !== files.length) {
    throw new Error("Operation coverage manifest does not match the real transaction fixtures");
  }
  const summaries: string[] = [];
  const moonwellExposures: string[] = [];
  const morphoExposures: string[] = [];
  let v4Intent: IntentAnalysis | undefined;
  let aerodromeIntent: IntentAnalysis | undefined;
  let morphoIntent: IntentAnalysis | undefined;

  for (const file of files) {
    const expectation = expectations.get(file);
    if (expectation === undefined) {
      throw new Error(`${file} is missing from the operation coverage manifest`);
    }
    const transaction = await loadTransaction(resolve(fixtureDirectory, file));
    process.stdout.write(`Replaying ${file}\n`);
    const evaluationTime = transaction.source?.timestamp ?? new Date().toISOString();
    const report = await analyzeWithRetry(transaction, policy, {
      generatedAt: evaluationTime,
      nowSeconds: Math.floor(Date.parse(evaluationTime) / 1000),
      rpcUrl,
    });
    const cashRejection = file === "moonwell-redeem-cash-rejection.base.json";
    const expectedSimulation = expectation.expectedSimulation === "pass";
    if (report.simulation.success !== expectedSimulation ||
        report.finalDecision !== expectation.expectedDecision) {
      throw new Error(`${file}: expected ${expectation.expectedDecision}, got ${report.finalDecision}; simulation=${report.simulation.error ?? report.simulation.success}; Moonwell=${report.moonwell?.status ?? "n/a"}; reasons=${report.policy.findings.map((finding) => finding.code).join(",")}`);
    }
    if (cashRejection && (report.simulation.returnData === undefined || BigInt(report.simulation.returnData) !== 14n ||
        !report.policy.findings.some((finding) => finding.code === "SIMULATION_FAILED"))) {
      throw new Error("Real Moonwell rejection must retain protocol error code 14");
    }
    if (report.intent.protocol === "moonwell") {
      if (report.moonwell?.status !== "ready" || !report.moonwell.exposures.length ||
          report.moonwell.blockHash !== report.simulation.blockHash ||
          (!cashRejection && report.intent.expectedBalanceChanges.some((change) => change.amount.mode !== "exact"))) {
        throw new Error(`${file} is missing concrete Moonwell exposure evidence: status=${report.moonwell?.status ?? "missing"}; exposures=${report.moonwell?.exposures.length ?? 0}; moonwellBlock=${report.moonwell?.blockHash ?? "missing"}; simulationBlock=${report.simulation.blockHash ?? "missing"}; modes=${report.intent.expectedBalanceChanges.map((change) => change.amount.mode).join(",")}`);
      }
      for (const exposure of report.moonwell.exposures) {
        moonwellExposures.push(`| ${file} | ${exposure.underlyingAmount} | ${exposure.receiptAmount} | ${exposure.receiptBalanceBefore} → ${exposure.receiptBalanceAfter} | ${exposure.debtBefore} → ${exposure.debtAfter} | ${exposure.collateralUnderlyingBefore} → ${exposure.collateralUnderlyingAfter} | ${cashRejection ? "not executable" : "simulation passed"} |`);
      }
    }
    if (report.intent.protocol === "morpho") {
      if (report.morpho?.status !== "ready" || !report.morpho.exposures.length ||
          report.morpho.blockHash !== report.simulation.blockHash ||
          report.intent.expectedBalanceChanges.some((change) => change.amount.mode !== "exact")) {
        throw new Error(`${file} is missing concrete Morpho fixed-block exposure evidence`);
      }
      for (const exposure of report.morpho.exposures) {
        morphoExposures.push(`| ${file} | ${exposure.operation} | ${exposure.assets} | ${exposure.shares} | ${exposure.supplySharesBefore} → ${exposure.supplySharesAfter} | ${exposure.borrowSharesBefore} → ${exposure.borrowSharesAfter} | ${exposure.collateralBefore} → ${exposure.collateralAfter} |`);
      }
      morphoIntent = report.intent;
    }
    if (report.permit2 && (!report.permit2.checks.length ||
        report.permit2.checks.some((check) => check.status !== "valid"))) {
      throw new Error(`${file} did not pass independent Permit2 verification`);
    }
    if (file === "uniswap-permit2-usdc.base.json") {
      const codes = report.policy.findings.map((finding) => finding.code).sort();
      if (JSON.stringify(codes) !== JSON.stringify(["AMOUNT_LIMIT_EXCEEDED", "PERMIT2_EXPIRATION_TOO_FAR"])) {
        throw new Error("Real Permit2 evidence must reject only the excessive amount and expiration");
      }
    }
    await writeFile(
      resolve(reportDirectory, file.replace(".base.json", ".report.json")),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );
    const operation = expectation.operations.join(", ");
    summaries.push(
      `| ${file} | ${report.intent.protocol} | ${operation} | ${transaction.source?.transactionHash ?? "n/a"} | ${report.finalDecision} | ${report.simulation.success ? "pass" : "expected protocol rejection (14)"} |`,
    );
    if (file === "uniswap-v4-exact-input.base.json") {
      v4Intent = report.intent;
    }
    if (file === "aerodrome-swap-usdc-aero.base.json") aerodromeIntent = report.intent;
  }

  if (v4Intent === undefined || aerodromeIntent === undefined || morphoIntent === undefined) {
    throw new Error("Missing Uniswap v4, Aerodrome or Morpho evidence vector");
  }
  const rejections = rejectionEvidence(v4Intent, aerodromeIntent, morphoIntent, policy);
  const testFiles = (await readdir(resolve("tests"))).filter((file) => file.endsWith(".test.ts")).sort();
  const testOutput = execFileSync(process.execPath,
    ["--import", "tsx", "--test", "--test-reporter=tap", ...testFiles.map((file) => resolve("tests", file))],
    { encoding: "utf8", maxBuffer: 5 * 1024 * 1024 });
  await writeFile(resolve(evidenceDirectory, "test-results.tap"), testOutput, "utf8");
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
- Aerodrome routes must use configured factories; unsafe and fee-on-transfer selectors fail closed.
- Moonwell borrowing is denied by the example policy.
- Morpho markets must match an explicit market-ID allowlist and verified canonical parameters.
- Failed RPC simulation is a rejection.

## Operation coverage

The machine-readable coverage manifest is [fixtures/operation-coverage.json](../fixtures/operation-coverage.json). It maps every committed Base transaction to the operations it proves and records the expected policy and simulation outcomes. Operations without an observed top-level transaction remain explicitly identified as deterministic-only coverage:

${coverage.deterministicOnly.map((entry) => `- ${entry.operation}: ${entry.reason} Test: \`${entry.test}\`.`).join("\n")}

## Balance-change interpretation

- Exact calldata bounds are reported as exact, minimum or maximum amounts.
- Moonwell amounts identify the calldata asset. Policy caps always compare underlying units after conversion at a fixed, accrued exchange rate.
- Moonwell receipt balances, underlying-valued supplied positions, debt and collateral membership/exposure are reported before and conditionally after execution. Missing verified state requires review.
- Mint and redeemUnderlying receipt calculations use floor rounding, matching the contract; max-uint sentinels apply only to redemption and repayment. Protocol return codes are checked for market and controller calls.
- Uniswap outputs are minimum guarantees; realized output still depends on pool state.
- Morpho share-denominated amounts are resolved from the successful fixed-block call return data before policy caps are applied.

## Moonwell fixed-block exposure evidence

All values are raw token units. Receipt quantities use mToken decimals; underlying and debt quantities use the underlying token decimals. These are conditional predictions valued at the checked accrued rate, not measured post-transaction balances.

| Fixture | Underlying amount | Receipt amount | Receipt balance before → after | Debt before → after | Collateral underlying before → after | Executability |
|---|---|---|---|---|---|---|
${moonwellExposures.join("\n")}

## Morpho fixed-block exposure evidence

The exact asset/share result comes from the historical call. Position shares and collateral are read immediately before that call at the same block and reported as conditional before/after values.

| Fixture | Operation | Assets | Shares | Supply shares before → after | Borrow shares before → after | Collateral before → after |
|---|---|---|---|---|---|---|
${morphoExposures.join("\n")}

## Limitations

- The cash-rejection vector is marked successful by the explorer at EVM level, but preceding-block simulation returns Moonwell error 14 (insufficient cash). It is intentionally rejected; its conditional exposure calculation must not be interpreted as executed movement. Explorer status alone is not protocol-success evidence.
- Moonwell support is limited to registered Base USDC/WETH markets. Fee-on-transfer and rebasing assets are outside this registry. Supplied/collateral valuation holds the checked accrued exchange rate fixed; post-operation rounding may change the eventual exchange rate. USD valuation and portfolio-wide liquidation health are not inferred.
- PermitSingle and PermitBatch signatures are independently checked using the Permit2 EIP-712 domain. EOA signatures support 65-byte and EIP-2098 encodings; contract wallets use EIP-1271 at the checked block.
- All four Router Permit2 commands are decoded. Nonce and explicit-transfer allowance consumption are checked in command order, with full-transaction simulation required for chain-state-dependent execution.
- The real Permit2 vector has a valid signature and successful historical execution. The default policy rejects its unlimited allowance and approximately 30-day authorization lifetime. This is an expected rejection, not a failed signature check.
- Allowance updates describe the authorization assigned by a permit and the maximum exposure change relative to the checked allowance. They are conditional on execution and are not the final residual allowance after swaps.
- Balance changes are operation-level calldata bounds, not a measured net portfolio delta. Exact swap output, token balances and ERC-20 approval sufficiency depend on the simulated chain state.
- Direct Permit2 SignatureTransfer/witness calls and nested Router subplans are outside the supported command set and fail closed. EIP-1271 coverage uses controlled RPC tests; the committed live Permit2 transaction is an EOA vector.
- All chain reads and simulation use a fixed block number; matching block hashes are required before policy pass. Historical preflight uses the preceding block, so transactions depending on earlier writes in the same block may fail this replay.
- Arbitrary Uniswap v4 hooks are outside the supported trust boundary.
- Aerodrome support covers the three standard exact-input methods. Fee-on-transfer and unsafe methods are deliberately unsupported.
- Morpho liquidation, flash loans and authorization mutation are outside the supported operation set. Market totals are recorded as stored at the checked block; operation asset/share deltas come from full call simulation after Morpho interest accrual.
- RPC simulation verifies call success at a fixed historical state; it does not guarantee execution against a later state.
- This project does not sign or broadcast transactions and is not production risk control without an independent audit.
`;
  await writeFile(resolve(evidenceDirectory, "simulation-and-risk-precheck.md"), riskReport, "utf8");

  const index = `# Acceptance evidence

This directory contains reproducible evidence for the Passport DeFi authorization acceptance criteria.

## Evidence map

- Real transaction calldata: [../fixtures/transactions](../fixtures/transactions)
- Operation-to-vector coverage and expected outcomes: [../fixtures/operation-coverage.json](../fixtures/operation-coverage.json)
- Parsed intent, expected balance changes, policy decision and RPC result: [reports](./reports)
- Policy configuration: [../config/policy.example.json](../config/policy.example.json)
- Eighteen explicit rejection paths: [rejection-tests.json](./rejection-tests.json)
- Simulation and risk precheck: [simulation-and-risk-precheck.md](./simulation-and-risk-precheck.md)
- Automated assertions: [../tests](../tests)
- Recorded assertion results, including Permit2 rejection paths: [test-results.tap](./test-results.tap)
- Moonwell units, conversion rules and exposure interpretation: [../docs/moonwell.md](../docs/moonwell.md)
- Permit2 scope and reproducible real-transaction audit: [../docs/permit2.md](../docs/permit2.md)
- Aerodrome selectors, routing and failure boundaries: [../docs/aerodrome.md](../docs/aerodrome.md)
- Morpho market identity and exposure verification: [../docs/morpho.md](../docs/morpho.md)

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
