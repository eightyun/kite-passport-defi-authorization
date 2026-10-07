#!/usr/bin/env node

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadPolicy, loadTransaction } from './io.js';
import { analyzeTransaction } from './report.js';
import { loadAuthorizationReport, verifyAuthorizationReceipt } from './receipt.js';

interface AnalyzeOptions {
    readonly transactionPath: string;
    readonly policyPath: string;
    readonly rpcUrl?: string;
    readonly outputPath?: string;
    readonly nowSeconds: number;
}

interface VerifyOptions {
    readonly reportPath: string;
    readonly policyPath: string;
    readonly block?: bigint;
}

type CliOptions =
    | { readonly command: 'analyze'; readonly options: AnalyzeOptions }
    | {
          readonly command: 'verify-report';
          readonly options: VerifyOptions;
      };

function option(args: readonly string[], name: string): string | undefined {
    const index = args.indexOf(name);
    if (index === -1) {
        return undefined;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
        throw new Error(`${name} requires a value`);
    }
    return value;
}

function usage(): string {
    return [
        'Usage:',
        '  kite-defi-auth analyze --transaction <file> --policy <file> [--rpc-url <url>] [--output <file>] [--now <unix-seconds>]',
        '  kite-defi-auth verify-report --report <file> --policy <file> [--block <number>]'
    ].join('\n');
}

function parseOptions(args: readonly string[]): CliOptions {
    if (args[0] === 'verify-report') {
        const reportPath = option(args, '--report');
        const policyPath = option(args, '--policy');
        if (reportPath === undefined || policyPath === undefined) throw new Error(usage());
        const rawBlock = option(args, '--block');
        let block: bigint | undefined;
        if (rawBlock !== undefined) {
            if (!/^\d+$/.test(rawBlock)) throw new Error('--block must be a non-negative block number');
            block = BigInt(rawBlock);
        }
        return {
            command: 'verify-report',
            options: {
                reportPath: resolve(reportPath),
                policyPath: resolve(policyPath),
                ...(block === undefined ? {} : { block })
            }
        };
    }
    if (args[0] !== 'analyze') throw new Error(usage());
    const transactionPath = option(args, '--transaction');
    const policyPath = option(args, '--policy');
    if (transactionPath === undefined || policyPath === undefined) {
        throw new Error(usage());
    }
    const now = option(args, '--now');
    const nowSeconds = now === undefined ? Math.floor(Date.now() / 1000) : Number(now);
    if (!Number.isInteger(nowSeconds) || nowSeconds < 0) {
        throw new Error('--now must be a non-negative Unix timestamp');
    }
    const rpcUrl = option(args, '--rpc-url');
    const outputPath = option(args, '--output');
    return {
        command: 'analyze',
        options: {
            transactionPath: resolve(transactionPath),
            policyPath: resolve(policyPath),
            ...(rpcUrl === undefined ? {} : { rpcUrl }),
            ...(outputPath === undefined ? {} : { outputPath: resolve(outputPath) }),
            nowSeconds
        }
    };
}

async function main(): Promise<void> {
    const command = parseOptions(process.argv.slice(2));
    if (command.command === 'verify-report') {
        const [report, policy] = await Promise.all([
            loadAuthorizationReport(command.options.reportPath),
            loadPolicy(command.options.policyPath)
        ]);
        const verification = verifyAuthorizationReceipt(report, policy, command.options.block);
        process.stdout.write(`${JSON.stringify(verification, null, 2)}\n`);
        process.exitCode = verification.valid ? 0 : 1;
        return;
    }
    const options = command.options;
    const [transaction, policy] = await Promise.all([
        loadTransaction(options.transactionPath),
        loadPolicy(options.policyPath)
    ]);
    const report = await analyzeTransaction(transaction, policy, {
        generatedAt: new Date(options.nowSeconds * 1000).toISOString(),
        nowSeconds: options.nowSeconds,
        ...(options.rpcUrl ? { rpcUrl: options.rpcUrl } : {})
    });
    const output = `${JSON.stringify(report, null, 2)}\n`;
    if (options.outputPath === undefined) {
        process.stdout.write(output);
    } else {
        await writeFile(options.outputPath, output, 'utf8');
    }
    process.exitCode = report.finalDecision === 'reject' ? 2 : 0;
}

main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
});
