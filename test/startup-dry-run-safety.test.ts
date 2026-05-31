import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runSetupCommand } from "../src/cli/onboarding/command-runner.js";
import { checkPlanLlmHealth } from "../src/modules/onboarding/llm-health.service.js";
import type { StartupPlan } from "../src/modules/onboarding/onboarding.types.js";
import { runStartupSeq } from "../src/modules/onboarding/startup.service.js";

vi.mock("../src/cli/onboarding/command-runner.js", () => ({
  runSetupCommand: vi.fn(),
}));

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
  checkPlanLlmHealth: vi.fn(),
}));

describe("startup-dry-run-safety", () => {
  it("should never write files or run stateful operations during dry-run", async () => {
    const dummyEnvPath = path.resolve(process.cwd(), ".env.safety-dryrun-test");
    if (existsSync(dummyEnvPath)) {
      rmSync(dummyEnvPath);
    }

    const plan: StartupPlan = {
      lang: "ja",
      database: {
        provider: "postgres",
        url: "postgres://non-existent-host:5432/db",
        startDocker: true,
      },
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

    expect(runSetupCommand).not.toHaveBeenCalled();
    expect(checkPlanLlmHealth).not.toHaveBeenCalled();

    // Assert dry-run only plans work and does not perform live checks.
    for (const step of summary.steps) {
      expect(step.status).not.toBe("failed");
      expect(step.status).toBe("skipped");
    }

    expect(summary.ok).toBe(true); // dry-run should return ok: true if plan calculation succeeds
  });
});
