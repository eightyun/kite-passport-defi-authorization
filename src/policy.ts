import { ZERO_ADDRESS } from "./contracts.js";
import type {
  Address,
  IntentAction,
  IntentAnalysis,
  PolicyConfig,
  PolicyDecision,
  PolicyFinding,
  SimulationResult,
  Permit2Verification,
} from "./domain.js";

export interface PolicyContext {
  readonly nowSeconds: number;
  readonly simulation: SimulationResult;
  readonly permit2?: Permit2Verification;
}

function addressSet(values: readonly Address[]): ReadonlySet<string> {
  return new Set(values.map((value) => value.toLowerCase()));
}

function concreteRecipient(recipient: string): Address | undefined {
  return /^0x[0-9a-fA-F]{40}$/.test(recipient) ? (recipient as Address) : undefined;
}

function actionTokens(action: IntentAction): readonly Address[] {
  if (action.kind === "swap") {
    return action.route.flatMap((step) => [step.tokenIn, step.tokenOut]);
  }
  if (action.kind === "lending") {
    return action.asset === undefined ? [] : [action.asset];
  }
  if (action.kind === "transfer") {
    return action.asset === undefined ? [] : [action.asset];
  }
  return [];
}

function actionRecipient(action: IntentAction): string | undefined {
  if (action.kind === "swap") {
    return action.recipient;
  }
  if (action.kind === "transfer") {
    return action.recipient;
  }
  if (action.kind === "lending") {
    return action.beneficiary;
  }
  return undefined;
}

function findAmountLimitFinding(
  action: IntentAction,
  maximumAmountByToken: Readonly<Record<string, string>>,
): PolicyFinding | undefined {
  let token: Address | undefined;
  let value: string | undefined;
  if (action.kind === "swap") {
    token = action.route[0]?.tokenIn;
    value = action.amountIn.mode === "all" || action.amountIn.mode === "unknown" ? undefined : action.amountIn.value;
  } else if (action.kind === "lending") {
    token = action.asset;
    value =
      action.amount === undefined || action.amount.mode === "all" || action.amount.mode === "unknown"
        ? undefined
        : action.amount.value;
  } else if (action.kind === "transfer") {
    token = action.asset;
    value =
      action.amount.mode === "all" || action.amount.mode === "unknown"
        ? undefined
        : action.amount.value;
  }
  if (token === undefined || value === undefined) {
    return undefined;
  }
  const maximum = maximumAmountByToken[token.toLowerCase()];
  if (maximum === undefined || BigInt(value) <= BigInt(maximum)) {
    return undefined;
  }
  return {
    code: "AMOUNT_LIMIT_EXCEEDED",
    message: `Amount ${value} exceeds the configured limit ${maximum} for ${token}.`,
    actionIndex: action.index,
    evidence: { token, amount: value, maximum },
  };
}

export function evaluatePolicy(
  intent: IntentAnalysis,
  config: PolicyConfig,
  context: PolicyContext,
): PolicyDecision {
  const findings: PolicyFinding[] = [];
  const targets = addressSet(config.allowedTargets);
  const tokens = addressSet(config.allowedTokens);
  const recipients = addressSet(config.allowedRecipients);
  const hooks = addressSet(config.allowedV4Hooks);
  const permit2Transferred = new Map<string, bigint>();

  if (!config.allowedChainIds.includes(intent.chainId)) {
    findings.push({
      code: "UNSUPPORTED_CHAIN",
      message: `Chain ${intent.chainId} is not allowed by policy.`,
      evidence: { chainId: intent.chainId },
    });
  }
  if (!targets.has(intent.target.toLowerCase())) {
    findings.push({
      code: "UNAUTHORIZED_TARGET",
      message: `Target contract ${intent.target} is not allowed by policy.`,
      evidence: { target: intent.target },
    });
  }
  if (BigInt(intent.nativeValue) > BigInt(config.maximumNativeValue)) {
    findings.push({
      code: "NATIVE_VALUE_LIMIT_EXCEEDED",
      message: `Native value ${intent.nativeValue} exceeds the configured limit ${config.maximumNativeValue}.`,
      evidence: { value: intent.nativeValue, maximum: config.maximumNativeValue },
    });
  }

  if (intent.deadline !== undefined) {
    const deadline = Number(intent.deadline);
    if (deadline < context.nowSeconds) {
      findings.push({
        code: "DEADLINE_EXPIRED",
        message: `Transaction deadline ${deadline} has expired.`,
        evidence: { deadline, now: context.nowSeconds },
      });
    } else if (deadline - context.nowSeconds > config.maximumDeadlineSeconds) {
      findings.push({
        code: "DEADLINE_TOO_FAR",
        message: `Transaction deadline is more than ${config.maximumDeadlineSeconds} seconds in the future.`,
        evidence: { deadline, now: context.nowSeconds, maximumSeconds: config.maximumDeadlineSeconds },
      });
    }
  }

  for (const action of intent.actions) {
    if (action.kind === "unknown") {
      findings.push({
        code: "UNKNOWN_ACTION",
        message: action.reason,
        actionIndex: action.index,
        evidence: { actionCode: action.code },
      });
      continue;
    }

    if (action.kind === "authorization") {
      const fail = (code: PolicyFinding["code"], message: string) =>
        findings.push({ code, message, actionIndex: action.index });
      const verification = context.permit2;
      const check = verification?.checks.find((entry) => entry.actionIndex === action.index);
      if (!action.decoded || (!action.permit && !action.transfers) || !check ||
          !intent.transactionFingerprint || verification?.transactionFingerprint !== intent.transactionFingerprint) {
        fail("UNVERIFIED_AUTHORIZATION", "Permit2 authorization details were not independently verified.");
      } else {
        findings.push(...check.findings);
        if (check.status !== "valid" && check.findings.length === 0) {
          fail("UNVERIFIED_AUTHORIZATION", "Permit2 validation did not succeed.");
        }
        if (!context.simulation.attempted || !context.simulation.success ||
            context.simulation.transactionFingerprint !== intent.transactionFingerprint ||
            !verification.blockHash || context.simulation.blockHash !== verification.blockHash) {
          fail("UNVERIFIED_AUTHORIZATION", "Permit2 requires successful full-transaction simulation at the same verified block.");
        }
      }
      const permit = action.permit;
      if (permit) {
        if (permit.owner.toLowerCase() !== intent.sender.toLowerCase()) fail("PERMIT2_OWNER_MISMATCH", "Permit2 owner must equal the Router sender.");
        if (permit.spender.toLowerCase() !== intent.target.toLowerCase()) fail("PERMIT2_SPENDER_NOT_ALLOWED", "Permit2 spender must equal the approved Router target.");
        const now = BigInt(context.nowSeconds);
        const deadline = BigInt(permit.sigDeadline);
        if (deadline < now) fail("PERMIT2_SIGNATURE_EXPIRED", "Permit2 signature deadline has expired.");
        if (deadline > now + BigInt(config.maximumPermit2SignatureDeadlineSeconds ?? config.maximumDeadlineSeconds)) {
          fail("PERMIT2_SIGNATURE_DEADLINE_TOO_FAR", "Permit2 signature deadline exceeds the configured horizon.");
        }
        if (!permit.details.length) fail("PERMIT2_EMPTY_BATCH", "Permit2 permit contains no token permissions.");
        for (const detail of permit.details) {
          if (detail.amount !== "0" && detail.expiration !== 0 && detail.expiration < context.nowSeconds) {
            fail("PERMIT2_ALLOWANCE_EXPIRED", "Permit2 allowance expiration is in the past.");
          }
          if (detail.expiration > context.nowSeconds + (config.maximumPermit2ExpirationSeconds ?? 86400)) {
            fail("PERMIT2_EXPIRATION_TOO_FAR", "Permit2 allowance expiration exceeds the configured horizon.");
          }
        }
      }
      if (action.transfers?.length === 0) fail("PERMIT2_EMPTY_BATCH", "Permit2 transfer batch is empty.");
      const entries = permit?.details ?? action.transfers ?? [];
      const totals = new Map<string, bigint>();
      for (const entry of entries) {
        const token = entry.token.toLowerCase();
        if (!tokens.has(token)) fail("UNAPPROVED_TOKEN", `Permit2 token ${entry.token} is not allowed.`);
        totals.set(token, (totals.get(token) ?? 0n) + BigInt(entry.amount));
      }
      for (const [token, value] of totals) {
        const maximum = config.maximumAmountByToken[token];
        const accumulated = action.transfers ? (permit2Transferred.get(token) ?? 0n) + value : value;
        if (action.transfers) permit2Transferred.set(token, accumulated);
        if (maximum === undefined) fail("PERMIT2_LIMIT_MISSING", `Permit2 requires an explicit amount limit for ${token}.`);
        else if (accumulated > BigInt(maximum)) fail("AMOUNT_LIMIT_EXCEEDED", `Permit2 amount ${accumulated} exceeds limit ${maximum} for ${token}.`);
      }
      for (const transfer of action.transfers ?? []) {
        if (transfer.from.toLowerCase() !== intent.sender.toLowerCase()) fail("PERMIT2_OWNER_MISMATCH", "Permit2 transfer owner must equal the Router sender.");
        const recipient = transfer.to.toLowerCase();
        if (recipient !== intent.sender.toLowerCase() && recipient !== intent.target.toLowerCase() && !recipients.has(recipient)) {
          fail("UNAPPROVED_RECIPIENT", `Permit2 recipient ${transfer.to} is not allowed.`);
        }
      }
    }

    for (const token of actionTokens(action)) {
      if (!tokens.has(token.toLowerCase())) {
        findings.push({
          code: "UNAPPROVED_TOKEN",
          message: `Token ${token} is not allowed by policy.`,
          actionIndex: action.index,
          evidence: { token },
        });
      }
    }

    const recipient = actionRecipient(action);
    const concrete = recipient === undefined ? undefined : concreteRecipient(recipient);
    if (
      concrete !== undefined &&
      concrete.toLowerCase() !== intent.sender.toLowerCase() &&
      !recipients.has(concrete.toLowerCase())
    ) {
      findings.push({
        code: "UNAPPROVED_RECIPIENT",
        message: `Recipient ${concrete} is not allowed by policy.`,
        actionIndex: action.index,
        evidence: { recipient: concrete },
      });
    }

    const amountFinding = findAmountLimitFinding(action, config.maximumAmountByToken);
    if (amountFinding !== undefined) {
      findings.push(amountFinding);
    }

    if (action.kind === "swap") {
      if (action.mode === "exact-input" && action.amountOut.value === "0") {
        findings.push({
          code: "ZERO_MINIMUM_OUTPUT",
          message: "Exact-input swap has no minimum output protection.",
          actionIndex: action.index,
        });
      }
      for (const step of action.route) {
        if (
          action.protocolVersion === "v4" &&
          step.hook !== undefined &&
          step.hook.toLowerCase() !== ZERO_ADDRESS.toLowerCase() &&
          !hooks.has(step.hook.toLowerCase())
        ) {
          findings.push({
            code: "V4_HOOK_NOT_ALLOWED",
            message: `Uniswap v4 hook ${step.hook} is not allowed by policy.`,
            actionIndex: action.index,
            evidence: { hook: step.hook },
          });
        }
        if (action.protocolVersion === "v4" && step.dynamicFee === true && !config.allowDynamicV4Fee) {
          findings.push({
            code: "DYNAMIC_V4_FEE_NOT_ALLOWED",
            message: "Uniswap v4 dynamic-fee pools are disabled by policy.",
            actionIndex: action.index,
          });
        }
      }
    }
    if (action.kind === "lending" && action.operation === "borrow" && !config.allowBorrow) {
      findings.push({
        code: "BORROW_NOT_ALLOWED",
        message: "Moonwell borrowing is disabled by policy.",
        actionIndex: action.index,
      });
    }
  }

  if (context.simulation.attempted && !context.simulation.success) {
    findings.push({
      code: "SIMULATION_FAILED",
      message: context.simulation.error ?? "Transaction simulation failed.",
    });
  }

  if (findings.length > 0) {
    return { outcome: "reject", findings };
  }
  if (config.requireSimulation && !context.simulation.attempted) {
    return {
      outcome: "review",
      findings: [
        {
          code: "SIMULATION_REQUIRED",
          message: "Policy requires RPC simulation before execution.",
        },
      ],
    };
  }
  return { outcome: "pass", findings: [] };
}
