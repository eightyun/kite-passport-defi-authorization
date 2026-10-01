#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadPolicy, loadTransaction } from "./io.js";
import { analyzeTransaction } from "./report.js";

interface CliOptions {
  readonly transactionPath: string;
  readonly policyPath: string;
  readonly rpcUrl?: string;
  readonly outputPath?: string;
  readonly nowSeconds: number;
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function usage(): string {
  return [
    "Usage:",
    "  kite-defi-auth analyze --transaction <file> --policy <file> [--rpc-url <url>] [--output <file>] [--now <unix-seconds>]",
  ].join("\n");
}

function parseOptions(args: readonly string[]): CliOptions {
  if (args[0] !== "analyze") {
    throw new Error(usage());
  }
  const transactionPath = option(args, "--transaction");
  const policyPath = option(args, "--policy");
  if (transactionPath === undefined || policyPath === undefined) {
    throw new Error(usage());
  }
  const now = option(args, "--now");
  const nowSeconds = now === undefined ? Math.floor(Date.now() / 1000) : Number(now);
  if (!Number.isInteger(nowSeconds) || nowSeconds < 0) {
    throw new Error("--now must be a non-negative Unix timestamp");
  }
  const rpcUrl = option(args, "--rpc-url");
  const outputPath = option(args, "--output");
  return {
    transactionPath: resolve(transactionPath),
    policyPath: resolve(policyPath),
    ...(rpcUrl === undefined ? {} : { rpcUrl }),
    ...(outputPath === undefined ? {} : { outputPath: resolve(outputPath) }),
    nowSeconds,
  };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const [transaction, policy] = await Promise.all([
    loadTransaction(options.transactionPath),
    loadPolicy(options.policyPath),
  ]);
  const report = await analyzeTransaction(transaction, policy, {
    generatedAt: new Date(options.nowSeconds * 1000).toISOString(),
    nowSeconds: options.nowSeconds,
    ...(options.rpcUrl ? { rpcUrl: options.rpcUrl } : {}),
  });
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (options.outputPath === undefined) {
    process.stdout.write(output);
  } else {
    await writeFile(options.outputPath, output, "utf8");
  }
  process.exitCode = report.finalDecision === "reject" ? 2 : 0;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
