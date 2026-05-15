import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { closeDbPool } from "../db/index.js";
import { syncAllAgentLogs } from "../modules/agent-log-sync/sync.service.js";

type LockHandle = {
  release: () => Promise<void>;
};

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
  const lock = await acquireLock(config.agentLogSyncLockFile, config.agentLogSyncLockTtlSeconds);
  try {
    const summary = await syncAllAgentLogs();
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
