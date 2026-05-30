import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { runStartupSeq } from "../src/modules/onboarding/startup.service.js";
import type { StartupPlan } from "../src/modules/onboarding/onboarding.types.js";

// Mock child processes and db connections to prevent environmental dependency
vi.mock("../src/cli/onboarding/command-runner.js", () => ({
  runSetupCommand: vi.fn().mockResolvedValue({ status: "success" }),
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
  checkPlanLlmHealth: vi.fn().mockResolvedValue({ ok: true, provider: "openai", message: "healthy" }),
}));

vi.mock("../src/modules/doctor/doctor.service.js", () => ({
  runDoctor: vi.fn().mockResolvedValue({ status: "ok", reasons: [] }),
}));

describe("startup.service apply flow", () => {
  const testEnvPath = path.resolve(process.cwd(), ".env.test-startup-service");

  beforeEach(() => {
    if (existsSync(testEnvPath)) {
      rmSync(testEnvPath);
    }
  });

  afterEach(() => {
    if (existsSync(testEnvPath)) {
      rmSync(testEnvPath);
    }
  });

  it("should successfully execute full sequential checklist in apply mode", async () => {
    const plan: StartupPlan = {
      lang: "ja",
      database: { provider: "postgres", url: "postgres://mock-host/db", startDocker: false },
      compile: { provider: "openai", openaiKey: "mock-key" },
      distillation: { provider: "local-llm", findCandidateProvider: "openai" },
      embedding: { provider: "auto" },
      project: { wikiRoot: "wiki/pages", importSeed: false },
      mcpClient: "generic",
    };

    const res = await runStartupSeq(plan, { dryRun: false, envPath: testEnvPath });
    expect(res.ok).toBe(true);
    expect(res.mode).toBe("apply");
    
    // Verify steps were successfully executed rather than skipped
    const dbConnStep = res.steps.find((s) => s.step === "db-connection");
    expect(dbConnStep?.status).toBe("success");

    const migrationStep = res.steps.find((s) => s.step === "db-migration");
    expect(migrationStep?.status).toBe("success");

    const doctorStep = res.steps.find((s) => s.step === "doctor-validation");
    expect(doctorStep?.status).toBe("success");
  });
});
