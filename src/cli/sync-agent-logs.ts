import fs from "node:fs/promises";
import path from "node:path";
import { groupedConfig } from "../config.js";
import { closeDbPool } from "../db/index.js";
import { syncAllAgentLogs } from "../modules/agent-log-sync/sync.service.js";

type LockHandle = {
  release: () => Promise<void>;
};

type CliOptions = {
  json: boolean;
};

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { json: false };
  for (const arg of args) {
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
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

  const stat = await fs.stat(lockFile).catch(() => null);
  const ageSeconds = stat ? (Date.now() - stat.mtimeMs) / 1000 : Number.POSITIVE_INFINITY;
  if (ageSeconds <= ttlSeconds) {
    throw new Error(`agent log sync is already running: ${lockFile}`);
  }

  await fs.unlink(lockFile).catch(() => undefined);
  return acquireLock(lockFile, ttlSeconds);
}

function hasFsErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const lock = await acquireLock(
    groupedConfig.agentLogSync.lockFile,
    groupedConfig.agentLogSync.lockTtlSeconds,
  );
  try {
    const summary = await syncAllAgentLogs();
    console.log(options.json ? JSON.stringify(summary, null, 2) : JSON.stringify(summary));
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
