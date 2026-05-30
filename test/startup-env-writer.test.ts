import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync, readdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  maskSecretValue,
  buildEnvRecord,
  buildEnvDiff,
  writeEnv,
} from "../src/modules/onboarding/env-writer.js";
import type { StartupPlan } from "../src/modules/onboarding/onboarding.types.js";

describe("env-writer", () => {
  const testEnvPath = path.resolve(process.cwd(), ".env.test-onboarding");

  beforeEach(() => {
    if (existsSync(testEnvPath)) {
      rmSync(testEnvPath);
    }
  });

  afterEach(() => {
    if (existsSync(testEnvPath)) {
      rmSync(testEnvPath);
    }
    // Clean up any generated backups
    const files = existsSync(process.cwd()) ? readdirSync(process.cwd()) : [];
    for (const f of files) {
      if (f.startsWith(".env.test-onboarding.bak-")) {
        rmSync(path.resolve(process.cwd(), f));
      }
    }
  });

  it("should mask secret values correctly", () => {
    expect(maskSecretValue("DATABASE_URL", "postgres://foo")).toBe("postgres://foo");
    expect(maskSecretValue("MEMORY_ROUTER_OPENAI_API_KEY", "sk-abcdefghijklmnopqrstuvwxyz")).toBe("sk-...wxyz");
    expect(maskSecretValue("MEMORY_ROUTER_OPENAI_API_KEY", "short")).toBe("****");
    expect(maskSecretValue("MEMORY_ROUTER_EMBEDDING_ACCESS_TOKEN", "1234567890")).toBe("123...890");
  });

  it("should build env record from plan", () => {
    const plan: StartupPlan = {
      lang: "ja",
      database: { provider: "postgres", url: "postgres://test-db", startDocker: false },
      compile: { provider: "openai", openaiKey: "test-key", openaiModel: "gpt-4" },
      distillation: { provider: "local-llm", findCandidateProvider: "openai" },
      embedding: { provider: "auto" },
      project: { wikiRoot: "wiki/pages", importSeed: true },
      mcpClient: "generic",
    };

    const record = buildEnvRecord(plan);
    expect(record["DATABASE_URL"]).toBe("postgres://test-db");
    expect(record["MEMORY_ROUTER_LANG"]).toBe("ja");
    expect(record["MEMORY_ROUTER_OPENAI_API_KEY"]).toBe("test-key");
    expect(record["MEMORY_ROUTER_AGENTIC_COMPILE_PROVIDER"]).toBe("openai");
  });

  it("should build env diff compared to current env", () => {
    const plan: StartupPlan = {
      lang: "en",
      database: { provider: "postgres", url: "postgres://new-db", startDocker: false },
      compile: { provider: "openai", openaiKey: "secret-key" },
      distillation: { provider: "local-llm", findCandidateProvider: "openai" },
      embedding: { provider: "auto" },
      project: { wikiRoot: "wiki/pages", importSeed: true },
      mcpClient: "generic",
    };

    const currentEnv = "DATABASE_URL=postgres://old-db\nMEMORY_ROUTER_LANG=en\n";
    const diff = buildEnvDiff(plan, currentEnv);

    expect(diff).toContain("~ DATABASE_URL=postgres://old-db -> postgres://new-db");
    expect(diff).toContain("+ MEMORY_ROUTER_OPENAI_API_KEY=sec...key");
    expect(diff).toContain("  MEMORY_ROUTER_LANG=en (unchanged)");
  });

  it("should write new values to .env and preserve other unrelated env keys", async () => {
    await writeFile(testEnvPath, "SOME_OTHER_KEY=do-not-touch\nDATABASE_URL=postgres://old\n");

    const plan: StartupPlan = {
      lang: "ja",
      database: { provider: "postgres", url: "postgres://new", startDocker: false },
      compile: { provider: "openai" },
      distillation: { provider: "local-llm", findCandidateProvider: "openai" },
      embedding: { provider: "auto" },
      project: { wikiRoot: "wiki/pages", importSeed: true },
      mcpClient: "generic",
    };

    const result = await writeEnv(plan, testEnvPath);
    expect(result.backupPath).toBeDefined();

    const writtenContent = await readFile(testEnvPath, "utf8");
    expect(writtenContent).toContain("SOME_OTHER_KEY=do-not-touch");
    expect(writtenContent).toContain("DATABASE_URL=postgres://new");
    expect(writtenContent).toContain("MEMORY_ROUTER_LANG=ja");
  });
});
