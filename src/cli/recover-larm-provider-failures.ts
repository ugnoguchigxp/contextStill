#!/usr/bin/env bun

import { closeDbPool } from "../db/index.js";
import {
  appendRecoveryAuditLog,
  recoverLarmProviderFailures,
  traceLarmRecoveryBatch,
} from "../modules/queue/core/larm-provider-recovery.js";

type Options =
  | { action: "requeue"; mode: "dry-run" | "write"; limit: number; batchId: string; log: string }
  | { action: "trace"; batchId: string; log: string };

function readValue(args: string[], index: number, name: string): [string, number] {
  const inline = args[index]?.match(new RegExp(`^${name}=(.*)$`))?.[1];
  if (inline !== undefined) return [inline, index];
  const next = args[index + 1];
  if (!next || next.startsWith("--")) throw new Error(`${name} requires a value`);
  return [next, index + 1];
}

export function parseArgs(args: string[]): Options {
  let action: "requeue" | "trace" = "requeue";
  let mode: "dry-run" | "write" = "dry-run";
  let limit: number | undefined;
  let batchId = `larm-recovery-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
  let log = "logs/queue-recovery.ndjson";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "trace") action = "trace";
    else if (arg === "--dry-run") mode = "dry-run";
    else if (arg === "--write") mode = "write";
    else if (arg === "--limit" || arg.startsWith("--limit=")) {
      const [raw, consumed] = readValue(args, index, "--limit");
      index = consumed;
      limit = Number(raw);
    } else if (arg === "--batch-id" || arg.startsWith("--batch-id=")) {
      const [raw, consumed] = readValue(args, index, "--batch-id");
      index = consumed;
      batchId = raw;
    } else if (arg === "--log" || arg.startsWith("--log=")) {
      const [raw, consumed] = readValue(args, index, "--log");
      index = consumed;
      log = raw;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage:\n  recover-larm-provider-failures [--dry-run|--write] --limit N [--batch-id ID] [--log PATH]\n  recover-larm-provider-failures trace --batch-id ID [--log PATH]\n",
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (action === "trace") return { action, batchId, log };
  if (mode === "write" && limit === undefined)
    throw new Error("--write requires an explicit --limit");
  return { action, mode, limit: limit ?? 100, batchId, log };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.action === "trace") {
    const result = await traceLarmRecoveryBatch(options.batchId);
    const auditLog = await appendRecoveryAuditLog({ action: "trace", result }, options.log);
    process.stdout.write(`${JSON.stringify({ ...result, auditLog }, null, 2)}\n`);
    return;
  }
  const result = await recoverLarmProviderFailures(options);
  const auditLog =
    options.mode === "write"
      ? await appendRecoveryAuditLog({ action: "requeue", result }, options.log)
      : null;
  process.stdout.write(`${JSON.stringify({ ...result, auditLog }, null, 2)}\n`);
}

if (import.meta.main) {
  main()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    })
    .finally(async () => closeDbPool());
}
