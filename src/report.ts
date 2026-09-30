import { decodeTransaction } from "./decode.js";
import type {
  AuthorizationReport,
  PolicyConfig,
  SimulationResult,
  TransactionEnvelope,
} from "./domain.js";
import { evaluatePolicy } from "./policy.js";

export interface ReportOptions {
  readonly generatedAt: string;
  readonly nowSeconds: number;
  readonly simulation: SimulationResult;
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
  });
  return {
    schemaVersion: "1.0",
    generatedAt: options.generatedAt,
    transaction,
    intent,
    policy,
    simulation: options.simulation,
    finalDecision: policy.outcome,
  };
}
