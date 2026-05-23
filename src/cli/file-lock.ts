import fs from "node:fs/promises";
import path from "node:path";

export type FileLockHandle = {
  release: () => Promise<void>;
};

type LockMetadata = {
  pid?: number;
  createdAt?: string;
  label?: string;
};

export type AcquireFileLockOptions = {
  lockFile: string;
  ttlSeconds: number;
  label: string;
  staleCreatedAgeSeconds?: number;
  removeWhenCreatedAgeExceeded?: boolean;
  wait?: boolean;
  waitTimeoutMs?: number;
  pollMs?: number;
};

export type FileLockState = {
  path: string;
  exists: boolean;
  pid: number | null;
  processAlive: boolean | null;
  createdAt: string | null;
  ageSeconds: number | null;
  staleByCreatedAge: boolean;
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
    // Missing or malformed metadata falls back to age-based stale handling.
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

function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

export async function readFileLockState(
  lockFile: string,
  staleCreatedAgeSeconds?: number,
): Promise<FileLockState> {
  const metadata = await readLockMetadata(lockFile);
  let stat: Awaited<ReturnType<typeof fs.stat>> | null = null;
  try {
    stat = await fs.stat(lockFile);
  } catch {
    stat = null;
  }
  if (!stat) {
    return {
      path: lockFile,
      exists: false,
      pid: null,
      processAlive: null,
      createdAt: null,
      ageSeconds: null,
      staleByCreatedAge: false,
    };
  }

  const pid =
    Number.isInteger(metadata.pid) && Number(metadata.pid) > 0 ? Number(metadata.pid) : null;
  const createdAtMs = parseTimestampMs(metadata.createdAt) ?? stat.mtimeMs;
  const ageSeconds = Math.max(0, Math.floor((Date.now() - createdAtMs) / 1000));
  const staleByCreatedAge =
    typeof staleCreatedAgeSeconds === "number" && ageSeconds > staleCreatedAgeSeconds;

  return {
    path: lockFile,
    exists: true,
    pid,
    processAlive: pid === null ? null : isProcessAlive(pid),
    createdAt: new Date(createdAtMs).toISOString(),
    ageSeconds,
    staleByCreatedAge,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function removeStaleLockIfSafe(
  lockFile: string,
  ttlSeconds: number,
  options?: Pick<AcquireFileLockOptions, "staleCreatedAgeSeconds" | "removeWhenCreatedAgeExceeded">,
): Promise<boolean> {
  const lockState = await readFileLockState(lockFile, options?.staleCreatedAgeSeconds);
  if (!lockState.exists) return false;
  if (lockState.processAlive === true) return false;

  if (lockState.processAlive === false) {
    await fs.unlink(lockFile).catch(() => undefined);
    return true;
  }

  if (options?.removeWhenCreatedAgeExceeded && lockState.staleByCreatedAge) {
    await fs.unlink(lockFile).catch(() => undefined);
    return true;
  }

  if ((lockState.ageSeconds ?? Number.POSITIVE_INFINITY) > ttlSeconds) {
    await fs.unlink(lockFile).catch(() => undefined);
    return true;
  }
  return false;
}

export async function acquireFileLock(options: AcquireFileLockOptions): Promise<FileLockHandle> {
  await fs.mkdir(path.dirname(options.lockFile), { recursive: true });
  const startedAt = Date.now();
  const pollMs = Math.max(250, options.pollMs ?? 5000);
  const waitTimeoutMs = options.waitTimeoutMs ?? options.ttlSeconds * 1000;

  while (true) {
    const metadata: LockMetadata = {
      pid: process.pid,
      createdAt: new Date().toISOString(),
      label: options.label,
    };
    try {
      const fileHandle = await fs.open(options.lockFile, "wx");
      await fileHandle.writeFile(JSON.stringify(metadata), "utf-8");
      await fileHandle.close();
      return {
        release: async () => {
          const current = await readLockMetadata(options.lockFile);
          if (current.pid === metadata.pid && current.createdAt === metadata.createdAt) {
            await fs.unlink(options.lockFile).catch(() => undefined);
          }
        },
      };
    } catch (error) {
      if (!hasFsErrorCode(error, "EEXIST")) throw error;
    }

    if (await removeStaleLockIfSafe(options.lockFile, options.ttlSeconds, options)) {
      continue;
    }

    if (!options.wait || Date.now() - startedAt >= waitTimeoutMs) {
      throw new Error(`${options.label} is already running: ${options.lockFile}`);
    }
    await sleep(pollMs);
  }
}
