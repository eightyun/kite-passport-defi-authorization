import { decodeTransaction } from "./decode.js";
import type {
  AuthorizationReport,
  PolicyConfig,
  SimulationResult,
  TransactionEnvelope,
  Permit2Verification,
} from "./domain.js";
import { evaluatePolicy } from "./policy.js";
import { verifyPermit2 } from "./permit2.js";
import { simulateTransaction, skippedSimulation } from "./simulation.js";

export interface ReportOptions {
  readonly generatedAt: string;
  readonly nowSeconds: number;
  readonly simulation: SimulationResult;
  readonly permit2?: Permit2Verification;
}

export function createAuthorizationReport(
  transaction: TransactionEnvelope,
  policyConfig: PolicyConfig,
  options: ReportOptions,
): AuthorizationReport {
  const intent = decodeTransaction(transaction);
  const policy = evaluatePolicy(intent, policyConfig, {
    nowSeconds: options.nowSeconds,
    simulation: options.simulation,
    ...(options.permit2 ? { permit2: options.permit2 } : {}),
  });
  return {
    schemaVersion: "1.0",
    generatedAt: options.generatedAt,
    transaction,
    intent,
    policy,
    simulation: options.simulation,
    finalDecision: policy.outcome,
    ...(options.permit2 ? { permit2: options.permit2 } : {}),
  };
}

export async function analyzeTransaction(
  transaction: TransactionEnvelope,
  policyConfig: PolicyConfig,
  options: { readonly generatedAt: string; readonly nowSeconds: number; readonly rpcUrl?: string },
): Promise<AuthorizationReport> {
  const intent = decodeTransaction(transaction);
  const needsPermit2 = intent.actions.some((action) => action.kind === "authorization");
  const blockNumber = transaction.source ? BigInt(transaction.source.blockNumber - 1) : undefined;
  const permit2 = needsPermit2 && options.rpcUrl
    ? await verifyPermit2(transaction, intent, options.rpcUrl, blockNumber) : undefined;
  const simulation = options.rpcUrl
    ? await simulateTransaction(transaction, options.rpcUrl,
      permit2?.blockNumber ? BigInt(permit2.blockNumber) : blockNumber)
    : skippedSimulation();
  return createAuthorizationReport(transaction, policyConfig, {
    generatedAt: options.generatedAt, nowSeconds: options.nowSeconds, simulation,
    ...(permit2 ? { permit2 } : {}),
  });
}
