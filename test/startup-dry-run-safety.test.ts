import { describe, it, expect, vi } from "vitest";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { runStartupSeq } from "../src/modules/onboarding/startup.service.js";
import type { StartupPlan } from "../src/modules/onboarding/onboarding.types.js";

vi.mock("pg", () => {
  class Client {
    async connect() {
      return undefined;
    }
    async end() {
      return undefined;
    }
  }
  return {
    default: {
      Client,
    },
    Client,
  };
});

vi.mock("../src/modules/onboarding/llm-health.service.js", () => ({
  checkPlanLlmHealth: vi.fn().mockResolvedValue({ ok: true, provider: "openai", message: "healthy" }),
}));

describe("startup-dry-run-safety", () => {
  it("should never write files or run stateful operations during dry-run", async () => {
    const dummyEnvPath = path.resolve(process.cwd(), ".env.safety-dryrun-test");
    if (existsSync(dummyEnvPath)) {
      rmSync(dummyEnvPath);
    }

    const plan: StartupPlan = {
      lang: "ja",
      database: { provider: "postgres", url: "postgres://non-existent-host:5432/db", startDocker: true },
      compile: { provider: "openai", openaiKey: "test" },
      distillation: { provider: "local-llm", findCandidateProvider: "openai" },
      embedding: { provider: "auto" },
      project: { wikiRoot: "wiki/pages", importSeed: true },
      mcpClient: "generic",
    };

    const summary = await runStartupSeq(plan, { dryRun: true, envPath: dummyEnvPath });

    // Assert envDiff is built but file is NOT written
    expect(summary.envDiff).toBeDefined();
    expect(existsSync(dummyEnvPath)).toBe(false);

    // Assert steps are all skipped or succeeded (like llm-health)
    for (const step of summary.steps) {
      expect(step.status).not.toBe("failed");
      if (step.step !== "llm-health") {
        expect(step.status).toBe("skipped");
      } else {
        expect(step.status).toBe("success");
      }
    }

    expect(summary.ok).toBe(true); // dry-run should return ok: true if plan calculation succeeds
  });
});
