import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ensureEnvFile, parseEnvValues } from "../src/cli/onboarding/env-file.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "memory-router-env-test-"));
  tempDirs.push(dir);
  return dir;
}

describe("onboarding env-file", () => {
  test("creates .env from .env.example and appends preferred locale when key is missing", async () => {
    const dir = await createTempDir();
    const envExamplePath = path.join(dir, ".env.example");
    const envPath = path.join(dir, ".env");

    await writeFile(envExamplePath, "DATABASE_URL=postgres://example\n", "utf8");
    const result = await ensureEnvFile({
      envPath,
      envExamplePath,
      preferredLocale: "en",
    });

    expect(result.created).toBe(true);
    expect(result.appendedKeys).toContain("MEMORY_ROUTER_LANG");

    const env = parseEnvValues(await readFile(envPath, "utf8"));
    expect(env.DATABASE_URL).toBe("postgres://example");
    expect(env.MEMORY_ROUTER_LANG).toBe("en");
  });

  test("keeps existing values and appends only missing keys", async () => {
    const dir = await createTempDir();
    const envExamplePath = path.join(dir, ".env.example");
    const envPath = path.join(dir, ".env");

    await writeFile(envExamplePath, "DATABASE_URL=postgres://example\nA=1\nB=2\n", "utf8");
    await writeFile(envPath, "DATABASE_URL=postgres://custom\nA=9\n", "utf8");
    const result = await ensureEnvFile({ envPath, envExamplePath });

    expect(result.created).toBe(false);
    expect(result.appendedKeys).toContain("B");
    expect(result.appendedKeys).not.toContain("A");

    const env = parseEnvValues(await readFile(envPath, "utf8"));
    expect(env.DATABASE_URL).toBe("postgres://custom");
    expect(env.A).toBe("9");
    expect(env.B).toBe("2");
  });
});
