import path from "node:path";
import { groupedConfig } from "../config.js";
import { closeDbPool } from "../db/index.js";
import { distillSources } from "../modules/sources/distillation.service.js";
import { acquireFileLock, type FileLockHandle } from "./file-lock.js";

type CliOptions = {
  apply: boolean;
  includeProcessed: boolean;
  limit?: number;
  sourceKind?: "wiki";
  uri?: string;
  agenticReader?: boolean;
};

function readArgValue(args: string[], index: number, name: string): string {
  const inline = args[index]?.match(new RegExp(`^${name}=(.*)$`))?.[1];
  if (inline !== undefined) return inline;
  const next = args[index + 1];
  if (!next || next.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return next;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    apply: false,
    includeProcessed: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--apply") {
      options.apply = true;
    } else if (arg === "--dry-run") {
      options.apply = false;
    } else if (arg === "--include-processed") {
      options.includeProcessed = true;
    } else if (arg === "--agentic-reader") {
      options.agenticReader = true;
    } else if (arg === "--json") {
      // JSON is the only output format for now.
    } else if (arg === "--limit" || arg.startsWith("--limit=")) {
      const rawValue = readArgValue(args, index, "--limit");
      if (arg === "--limit") index += 1;
      const parsed = Number(rawValue);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error("--limit must be a positive integer");
      }
      options.limit = parsed;
    } else if (arg === "--source-kind" || arg.startsWith("--source-kind=")) {
      const value = readArgValue(args, index, "--source-kind").trim();
      if (arg === "--source-kind") index += 1;
      if (value !== "wiki") throw new Error("--source-kind must be wiki");
      options.sourceKind = value;
    } else if (arg === "--uri" || arg.startsWith("--uri=")) {
      const value = readArgValue(args, index, "--uri").trim();
      if (arg === "--uri") index += 1;
      if (!value) throw new Error("--uri must not be empty");
      options.uri = path.resolve(value);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const lock = await acquireFileLock({
    lockFile: groupedConfig.sourceDistillation.lockFile,
    ttlSeconds: groupedConfig.sourceDistillation.lockTtlSeconds,
    label: "source distillation",
  });
  let sharedLock: FileLockHandle | null = null;
  try {
    sharedLock = await acquireFileLock({
      lockFile: groupedConfig.distillation.lockFile,
      ttlSeconds: groupedConfig.distillation.lockTtlSeconds,
      label: "distillation",
      wait: true,
    });
    const summary = await distillSources(options);
    console.log(JSON.stringify(summary, null, 2));
    if (!summary.ok) {
      process.exitCode = 1;
    }
  } finally {
    await sharedLock?.release();
    await lock.release();
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbPool();
  });
