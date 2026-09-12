import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  discoverBunTests,
  runTestProcess,
  sqliteTestEnvironment,
  validateSqliteManifest,
} from "../scripts/testing/sqlite-test-suite.mjs";

describe("SQLite CI suite", () => {
  test("fails for unregistered, removed and duplicate test files", () => {
    const manifest = { version: 1, tests: ["test/a.bun.ts"] };
    expect(() => validateSqliteManifest(manifest, ["test/a.bun.ts", "test/new.bun.ts"])).toThrow(
      "Unregistered Bun test",
    );
    expect(() => validateSqliteManifest(manifest, [])).toThrow("Missing Bun test");
    expect(() =>
      validateSqliteManifest({ version: 1, tests: ["test/a.bun.ts", "test/a.bun.ts"] }, [
        "test/a.bun.ts",
      ]),
    ).toThrow("Duplicate");
  });

  test("discovers nested Bun tests without collecting Vitest files", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sqlite-manifest-test-"));
    try {
      await mkdir(path.join(directory, "nested"));
      await writeFile(path.join(directory, "nested", "a.bun.ts"), "");
      await writeFile(path.join(directory, "b.test.ts"), "");
      expect(await discoverBunTests(directory)).toEqual(["test/nested/a.bun.ts"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("does not inherit live endpoints, DB paths, provider secrets or dotenv files", () => {
    const env = sqliteTestEnvironment(
      {
        PATH: "/toolchain",
        OPENAI_API_KEY: "synthetic-secret",
        CONTEXT_STILL_SQLITE_CORE_PATH: "/live/core.sqlite",
        CONTEXT_STILL_MCP_ENDPOINT_PATH: "/live/endpoint.json",
        DOTENV_CONFIG_PATH: "/live/.env",
        DATABASE_URL: "postgres://live",
      },
      "/isolated",
    );
    expect(env.PATH).toBe("/toolchain");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.CONTEXT_STILL_SQLITE_CORE_PATH).toBe("/isolated/core.sqlite");
    expect(env.CONTEXT_STILL_MCP_ENDPOINT_PATH).toBe("/isolated/mcp-endpoint.json");
    expect(env.DOTENV_CONFIG_PATH).toBe("/isolated/empty.env");
    expect(env.DATABASE_URL).toContain("127.0.0.1:1");
    expect(env.NODE_ENV).toBe("test");
  });

  test("propagates child failure and launch errors", async () => {
    expect(await runTestProcess(process.execPath, ["-e", "process.exit(7)"], {})).toBe(7);
    expect(await runTestProcess("/nonexistent/sqlite-test-runner", [], {})).toBe(1);
  });
});
