import { decodeTransaction } from "./decode.js";
import type {
  AuthorizationReport,
  PolicyConfig,
  SimulationResult,
  TransactionEnvelope,
  Permit2Verification,
  MoonwellPreflight,
} from "./domain.js";
import { evaluatePolicy } from "./policy.js";
import { verifyPermit2 } from "./permit2.js";
import { simulateTransaction, skippedSimulation } from "./simulation.js";
import { preflightMoonwell, resolveMoonwellIntent } from "./moonwell.js";

export interface ReportOptions {
  readonly generatedAt: string;
  readonly nowSeconds: number;
  readonly simulation: SimulationResult;
  readonly permit2?: Permit2Verification;
  readonly moonwell?: MoonwellPreflight;
}

export function createAuthorizationReport(
  transaction: TransactionEnvelope,
  policyConfig: PolicyConfig,
  options: ReportOptions,
): AuthorizationReport {
  const decoded = decodeTransaction(transaction);
  const intent = options.moonwell ? resolveMoonwellIntent(decoded, options.moonwell, options.simulation) : decoded;
  const policy = evaluatePolicy(intent, policyConfig, {
    nowSeconds: options.nowSeconds,
    simulation: options.simulation,
    ...(options.permit2 ? { permit2: options.permit2 } : {}),
    ...(options.moonwell ? { moonwell: options.moonwell } : {}),
  });
  return {
    schemaVersion: "1.0",
    generatedAt: options.generatedAt,
    transaction,
    intent,
    policy,
    simulation: options.simulation,
    finalDecision: policy.outcome,
    ...(options.moonwell ? { moonwell: options.moonwell } : {}),
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
  const moonwell = intent.protocol === "moonwell" && options.rpcUrl
    ? await preflightMoonwell(transaction, intent, options.rpcUrl, blockNumber) : undefined;
  const verifiedBlock = permit2?.blockNumber ?? moonwell?.blockNumber;
  const simulation = options.rpcUrl
    ? await simulateTransaction(transaction, options.rpcUrl,
      verifiedBlock ? BigInt(verifiedBlock) : blockNumber)
    : skippedSimulation();
  return createAuthorizationReport(transaction, policyConfig, {
    generatedAt: options.generatedAt, nowSeconds: options.nowSeconds, simulation,
    ...(permit2 ? { permit2 } : {}),
    ...(moonwell ? { moonwell } : {}),
  });
}
