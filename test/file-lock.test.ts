import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { acquireFileLock } from "../src/cli/file-lock.js";

const tempRoots: string[] = [];

async function createTempLockPath(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-router-lock-"));
  tempRoots.push(root);
  return path.join(root, "distillation.lock");
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("acquireFileLock", () => {
  test("rejects a second lock while the owner process is alive", async () => {
    const lockFile = await createTempLockPath();
    const lock = await acquireFileLock({
      lockFile,
      ttlSeconds: 60,
      label: "distillation",
    });

    await expect(
      acquireFileLock({
        lockFile,
        ttlSeconds: 60,
        label: "distillation",
      }),
    ).rejects.toThrow("distillation is already running");

    await lock.release();
    await expect(fs.stat(lockFile)).rejects.toThrow();
  });

  test("reclaims an age-expired lock when no owner pid is known", async () => {
    const lockFile = await createTempLockPath();
    await fs.mkdir(path.dirname(lockFile), { recursive: true });
    await fs.writeFile(lockFile, "not-json", "utf-8");
    const old = new Date(Date.now() - 120_000);
    await fs.utimes(lockFile, old, old);

    const lock = await acquireFileLock({
      lockFile,
      ttlSeconds: 1,
      label: "distillation",
    });

    await lock.release();
    await expect(fs.stat(lockFile)).rejects.toThrow();
  });

  test("reclaims a created-age-expired lock even when the recorded pid is alive", async () => {
    const lockFile = await createTempLockPath();
    await fs.mkdir(path.dirname(lockFile), { recursive: true });
    await fs.writeFile(
      lockFile,
      JSON.stringify({
        pid: process.pid,
        createdAt: new Date(Date.now() - 12 * 60_000).toISOString(),
        label: "distillation pipeline",
      }),
      "utf-8",
    );

    const lock = await acquireFileLock({
      lockFile,
      ttlSeconds: 660,
      staleCreatedAgeSeconds: 660,
      removeWhenCreatedAgeExceeded: true,
      label: "distillation pipeline",
    });

    await lock.release();
    await expect(fs.stat(lockFile)).rejects.toThrow();
  });

  test("waits for a held lock before acquiring", async () => {
    const lockFile = await createTempLockPath();
    const firstLock = await acquireFileLock({
      lockFile,
      ttlSeconds: 60,
      label: "distillation",
    });

    setTimeout(() => {
      void firstLock.release();
    }, 50);

    const secondLock = await acquireFileLock({
      lockFile,
      ttlSeconds: 60,
      label: "distillation",
      wait: true,
      waitTimeoutMs: 2000,
      pollMs: 250,
    });

    await secondLock.release();
    await expect(fs.stat(lockFile)).rejects.toThrow();
  });
});
