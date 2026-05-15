import fs from "node:fs/promises";
import path from "node:path";
import { groupedConfig } from "../config.js";
import { closeDbPool } from "../db/index.js";
import { distillVibeMemories } from "../modules/vibe-memory/distillation.service.js";

type LockHandle = {
  release: () => Promise<void>;
};

type LockMetadata = {
  pid?: number;
  createdAt?: string;
};

type CliOptions = {
  apply: boolean;
  includeProcessed: boolean;
  limit?: number;
  sessionId?: string;
  vibeMemoryIds?: string[];
};

function hasFsErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

async function readLockMetadata(lockFile: string): Promise<LockMetadata> {
  try {
    const raw = await fs.readFile(lockFile, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as LockMetadata;
    }
  } catch {
    // Unreadable metadata falls back to TTL handling below.
  }
  return {};
}

function isProcessAlive(pid: unknown): boolean | null {
  if (!Number.isInteger(pid) || Number(pid) <= 0) return null;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    if (hasFsErrorCode(error, "ESRCH")) return false;
    return true;
  }
}

async function acquireLock(lockFile: string, ttlSeconds: number): Promise<LockHandle> {
  await fs.mkdir(path.dirname(lockFile), { recursive: true });

  try {
    const fileHandle = await fs.open(lockFile, "wx");
    await fileHandle.writeFile(
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
      "utf-8",
    );
    return {
      release: async () => {
        await fileHandle.close();
        await fs.unlink(lockFile).catch(() => undefined);
      },
    };
  } catch (error) {
    if (!hasFsErrorCode(error, "EEXIST")) throw error;
  }

  const metadata = await readLockMetadata(lockFile);
  if (isProcessAlive(metadata.pid) === false) {
    await fs.unlink(lockFile).catch(() => undefined);
    return acquireLock(lockFile, ttlSeconds);
  }

  const stat = await fs.stat(lockFile).catch(() => null);
  const ageSeconds = stat ? (Date.now() - stat.mtimeMs) / 1000 : Number.POSITIVE_INFINITY;
  if (ageSeconds <= ttlSeconds) {
    throw new Error(`vibe memory distillation is already running: ${lockFile}`);
  }

  await fs.unlink(lockFile).catch(() => undefined);
  return acquireLock(lockFile, ttlSeconds);
}

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
  const lock = await acquireLock(
    groupedConfig.vibeDistillation.lockFile,
    groupedConfig.vibeDistillation.lockTtlSeconds,
  );
  try {
    const summary = await distillVibeMemories(options);
    console.log(JSON.stringify(summary, null, 2));
    if (!summary.ok) {
      process.exitCode = 1;
    }
  } finally {
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
