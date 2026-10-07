import { readFile } from 'node:fs/promises';
import { isHex, keccak256, toBytes } from 'viem';
import type {
    AuthorizationReceipt,
    AuthorizationReport,
    Hex,
    PolicyConfig,
    ReceiptVerificationResult
} from './domain.js';
import { transactionFingerprint } from './permit2.js';

export const ANALYZER_NAME = '@eightyun/kite-passport-defi-authorization' as const;
export const ANALYZER_VERSION = '0.2.0';

function canonicalJson(value: unknown): string {
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new Error('Canonical JSON cannot encode non-finite numbers');
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>)
            .filter(([, entry]) => entry !== undefined)
            .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
        return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
    }
    throw new Error(`Canonical JSON cannot encode ${typeof value}`);
}

export function canonicalHash(value: unknown): Hex {
    return keccak256(toBytes(canonicalJson(value)));
}

export function policyHash(policy: PolicyConfig): Hex {
    return canonicalHash(policy);
}

function reportPayload(report: AuthorizationReport): Omit<AuthorizationReport, 'receipt'> {
    const { receipt: _receipt, ...payload } = report;
    return payload;
}

export function createAuthorizationReceipt(
    report: Omit<AuthorizationReport, 'receipt'>,
    policy: PolicyConfig
): AuthorizationReceipt {
    const blockNumber = report.simulation.blockNumber;
    const blockHash = report.simulation.blockHash;
    return {
        analyzer: ANALYZER_NAME,
        analyzerVersion: ANALYZER_VERSION,
        policyHash: policyHash(policy),
        reportHash: canonicalHash(report),
        transactionFingerprint: transactionFingerprint(report.transaction),
        ...(blockNumber === undefined
            ? {}
            : {
                  validFromBlock: blockNumber,
                  validUntilBlock: blockNumber
              }),
        ...(blockHash === undefined ? {} : { verificationBlockHash: blockHash })
    };
}

function isAuthorizationReport(value: unknown): value is AuthorizationReport {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const report = value as Record<string, unknown>;
    return (
        report.schemaVersion === '1.0' &&
        typeof report.generatedAt === 'string' &&
        typeof report.transaction === 'object' &&
        report.transaction !== null &&
        typeof report.intent === 'object' &&
        report.intent !== null &&
        typeof report.policy === 'object' &&
        report.policy !== null &&
        typeof report.simulation === 'object' &&
        report.simulation !== null &&
        ['pass', 'reject', 'review'].includes(String(report.finalDecision))
    );
}

export function verifyAuthorizationReceipt(
    value: unknown,
    policy: PolicyConfig,
    atBlock?: bigint
): ReceiptVerificationResult {
    const findings: string[] = [];
    if (!isAuthorizationReport(value)) {
        return {
            valid: false,
            analyzer: ANALYZER_NAME,
            analyzerVersion: ANALYZER_VERSION,
            findings: ['Report structure or schema version is invalid.']
        };
    }
    const report = value;
    const receipt = report.receipt;
    if (!receipt) {
        return {
            valid: false,
            analyzer: ANALYZER_NAME,
            analyzerVersion: ANALYZER_VERSION,
            findings: ['Report does not contain an authorization receipt.']
        };
    }
    let expectedPolicyHash: Hex;
    let expectedReportHash: Hex;
    let expectedFingerprint: Hex;
    try {
        expectedPolicyHash = policyHash(policy);
        expectedReportHash = canonicalHash(reportPayload(report));
        expectedFingerprint = transactionFingerprint(report.transaction);
    } catch {
        return {
            valid: false,
            analyzer: ANALYZER_NAME,
            analyzerVersion: ANALYZER_VERSION,
            findings: ['Report contains invalid canonical data or transaction fields.']
        };
    }
    if (receipt.analyzer !== ANALYZER_NAME) findings.push('Analyzer identity does not match this verifier.');
    if (receipt.analyzerVersion !== ANALYZER_VERSION) findings.push('Analyzer version does not match this verifier.');
    if (!isHex(receipt.policyHash, { strict: true }) || receipt.policyHash !== expectedPolicyHash)
        findings.push('Policy hash does not match the supplied normalized policy.');
    if (!isHex(receipt.reportHash, { strict: true }) || receipt.reportHash !== expectedReportHash)
        findings.push('Report payload hash does not match the receipt.');
    if (receipt.transactionFingerprint !== expectedFingerprint)
        findings.push('Transaction fingerprint does not match the report transaction.');
    if (report.intent.transactionFingerprint !== expectedFingerprint)
        findings.push('Intent fingerprint does not match the report transaction.');
    if (report.policy.outcome !== report.finalDecision)
        findings.push('Final decision does not match the policy outcome.');

    const simulationBlock = report.simulation.blockNumber;
    const simulationHash = report.simulation.blockHash;
    const validBlock = (value: unknown): value is string => typeof value === 'string' && /^\d+$/.test(value);
    if (simulationBlock === undefined) {
        if (
            receipt.validFromBlock !== undefined ||
            receipt.validUntilBlock !== undefined ||
            receipt.verificationBlockHash !== undefined
        )
            findings.push('Receipt claims block validity without fixed-block simulation evidence.');
    } else if (!validBlock(simulationBlock)) {
        findings.push('Simulation block number is invalid.');
    } else {
        if (receipt.validFromBlock !== simulationBlock || receipt.validUntilBlock !== simulationBlock)
            findings.push('Receipt validity must be bound to the exact simulation block.');
        if (simulationHash === undefined || receipt.verificationBlockHash !== simulationHash)
            findings.push('Receipt block hash does not match the simulation block hash.');
    }
    if (atBlock !== undefined) {
        if (!validBlock(receipt.validFromBlock) || !validBlock(receipt.validUntilBlock)) {
            findings.push('Report is not bound to a block and cannot be verified for a requested block.');
        } else if (atBlock < BigInt(receipt.validFromBlock) || atBlock > BigInt(receipt.validUntilBlock)) {
            findings.push('Requested block is outside the receipt validity range.');
        }
    }
    return {
        valid: findings.length === 0,
        analyzer: receipt.analyzer,
        analyzerVersion: receipt.analyzerVersion,
        policyHash: receipt.policyHash,
        reportHash: receipt.reportHash,
        transactionFingerprint: receipt.transactionFingerprint,
        ...(receipt.validFromBlock === undefined ? {} : { validFromBlock: receipt.validFromBlock }),
        ...(receipt.validUntilBlock === undefined ? {} : { validUntilBlock: receipt.validUntilBlock }),
        ...(atBlock === undefined ? {} : { verifiedAtBlock: atBlock.toString() }),
        findings
    };
}

export async function loadAuthorizationReport(path: string): Promise<unknown> {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
}
