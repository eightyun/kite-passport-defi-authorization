import { decodeTransaction } from './decode.js';
import type {
    AuthorizationReport,
    PolicyConfig,
    SimulationResult,
    TransactionEnvelope,
    Permit2Verification,
    MoonwellPreflight,
    MorphoPreflight,
    AavePreflight,
    CompoundPreflight,
    AvantisPreflight
} from './domain.js';
import { evaluatePolicy } from './policy.js';
import { verifyPermit2 } from './permit2.js';
import { simulateTransaction, skippedSimulation } from './simulation.js';
import { preflightMoonwell, resolveMoonwellIntent } from './moonwell.js';
import { preflightMorpho, resolveMorpho } from './morpho.js';
import { preflightAvantis } from './avantis.js';
import { preflightAave, resolveAaveIntent } from './aave.js';
import { preflightCompound, resolveCompoundIntent } from './compound.js';
import { createAuthorizationReceipt } from './receipt.js';

export interface ReportOptions {
    readonly generatedAt: string;
    readonly nowSeconds: number;
    readonly simulation: SimulationResult;
    readonly permit2?: Permit2Verification;
    readonly moonwell?: MoonwellPreflight;
    readonly morpho?: MorphoPreflight;
    readonly aave?: AavePreflight;
    readonly compound?: CompoundPreflight;
    readonly avantis?: AvantisPreflight;
}

export function createAuthorizationReport(
    transaction: TransactionEnvelope,
    policyConfig: PolicyConfig,
    options: ReportOptions
): AuthorizationReport {
    const decoded = decodeTransaction(transaction);
    const moonwellIntent = options.moonwell
        ? resolveMoonwellIntent(decoded, options.moonwell, options.simulation)
        : decoded;
    const morphoResolved = options.morpho
        ? resolveMorpho(moonwellIntent, options.morpho, options.simulation)
        : undefined;
    const morphoIntent = morphoResolved?.intent ?? moonwellIntent;
    const morpho = morphoResolved?.state ?? options.morpho;
    const aaveIntent = options.aave ? resolveAaveIntent(morphoIntent, options.aave, options.simulation) : morphoIntent;
    const intent = options.compound
        ? resolveCompoundIntent(aaveIntent, options.compound, options.simulation)
        : aaveIntent;
    const policy = evaluatePolicy(intent, policyConfig, {
        nowSeconds: options.nowSeconds,
        simulation: options.simulation,
        ...(options.permit2 ? { permit2: options.permit2 } : {}),
        ...(options.moonwell ? { moonwell: options.moonwell } : {}),
        ...(morpho ? { morpho } : {}),
        ...(options.aave ? { aave: options.aave } : {}),
        ...(options.compound ? { compound: options.compound } : {}),
        ...(options.avantis ? { avantis: options.avantis } : {})
    });
    const report: Omit<AuthorizationReport, 'receipt'> = {
        schemaVersion: '1.0',
        generatedAt: options.generatedAt,
        transaction,
        intent,
        policy,
        simulation: options.simulation,
        finalDecision: policy.outcome,
        ...(options.moonwell ? { moonwell: options.moonwell } : {}),
        ...(morpho ? { morpho } : {}),
        ...(options.aave ? { aave: options.aave } : {}),
        ...(options.compound ? { compound: options.compound } : {}),
        ...(options.permit2 ? { permit2: options.permit2 } : {}),
        ...(options.avantis ? { avantis: options.avantis } : {})
    };
    return {
        ...report,
        receipt: createAuthorizationReceipt(report, policyConfig)
    };
}

export async function analyzeTransaction(
    transaction: TransactionEnvelope,
    policyConfig: PolicyConfig,
    options: { readonly generatedAt: string; readonly nowSeconds: number; readonly rpcUrl?: string }
): Promise<AuthorizationReport> {
    const intent = decodeTransaction(transaction);
    const needsPermit2 = intent.actions.some((action) => action.kind === 'authorization');
    const blockNumber = transaction.source ? BigInt(transaction.source.blockNumber - 1) : undefined;
    const permit2 =
        needsPermit2 && options.rpcUrl
            ? await verifyPermit2(transaction, intent, options.rpcUrl, blockNumber)
            : undefined;
    const moonwell =
        intent.protocol === 'moonwell' && options.rpcUrl
            ? await preflightMoonwell(transaction, intent, options.rpcUrl, blockNumber)
            : undefined;
    const morpho =
        intent.protocol === 'morpho' && options.rpcUrl
            ? await preflightMorpho(transaction, intent, options.rpcUrl, blockNumber)
            : undefined;
    const avantis =
        intent.protocol === 'avantis' && options.rpcUrl
            ? await preflightAvantis(transaction, intent, options.rpcUrl, blockNumber)
            : undefined;
    const aave =
        intent.protocol === 'aave' && options.rpcUrl
            ? await preflightAave(transaction, intent, options.rpcUrl, blockNumber)
            : undefined;
    const compound =
        intent.protocol === 'compound' && options.rpcUrl
            ? await preflightCompound(transaction, intent, options.rpcUrl, blockNumber)
            : undefined;
    const verifiedBlock =
        permit2?.blockNumber ??
        moonwell?.blockNumber ??
        morpho?.blockNumber ??
        avantis?.blockNumber ??
        aave?.blockNumber ??
        compound?.blockNumber;
    const simulation = options.rpcUrl
        ? await simulateTransaction(transaction, options.rpcUrl, verifiedBlock ? BigInt(verifiedBlock) : blockNumber)
        : skippedSimulation();
    return createAuthorizationReport(transaction, policyConfig, {
        generatedAt: options.generatedAt,
        nowSeconds: options.nowSeconds,
        simulation,
        ...(permit2 ? { permit2 } : {}),
        ...(moonwell ? { moonwell } : {}),
        ...(morpho ? { morpho } : {}),
        ...(aave ? { aave } : {}),
        ...(compound ? { compound } : {}),
        ...(avantis ? { avantis } : {})
    });
}
