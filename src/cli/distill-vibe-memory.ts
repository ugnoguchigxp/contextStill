import { groupedConfig } from "../config.js";
import { closeDbPool } from "../db/index.js";
import { assertLegacyDistillationEnabled } from "../modules/distillation/legacy-distillation-guard.js";
import { distillVibeMemories } from "../modules/vibe-memory/distillation.service.js";
import { acquireFileLock, type FileLockHandle } from "./file-lock.js";

type CliOptions = {
  apply: boolean;
  includeProcessed: boolean;
  limit?: number;
  sessionId?: string;
  vibeMemoryIds?: string[];
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

function appendListOption(current: string[] | undefined, rawValue: string): string[] {
  const values = rawValue
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return [...(current ?? []), ...values];
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
    } else if (arg === "--session-id" || arg.startsWith("--session-id=")) {
      const value = readArgValue(args, index, "--session-id").trim();
      if (arg === "--session-id") index += 1;
      if (!value) throw new Error("--session-id must not be empty");
      options.sessionId = value;
    } else if (arg === "--vibe-memory-id" || arg.startsWith("--vibe-memory-id=")) {
      const value = readArgValue(args, index, "--vibe-memory-id");
      if (arg === "--vibe-memory-id") index += 1;
      const nextIds = appendListOption(options.vibeMemoryIds, value);
      if (nextIds.length === (options.vibeMemoryIds?.length ?? 0)) {
        throw new Error("--vibe-memory-id must not be empty");
      }
      options.vibeMemoryIds = nextIds;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  assertLegacyDistillationEnabled("distill-vibe-memory CLI");
  const lock = await acquireFileLock({
    lockFile: groupedConfig.vibeDistillation.lockFile,
    ttlSeconds: groupedConfig.vibeDistillation.lockTtlSeconds,
    label: "vibe memory distillation",
  });
  let sharedLock: FileLockHandle | null = null;
  try {
    sharedLock = await acquireFileLock({
      lockFile: groupedConfig.distillation.lockFile,
      ttlSeconds: groupedConfig.distillation.lockTtlSeconds,
      label: "distillation",
      wait: true,
    });
    const summary = await distillVibeMemories(options);
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
