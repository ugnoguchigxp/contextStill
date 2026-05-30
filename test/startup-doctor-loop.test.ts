import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { runStartupSeq } from "../src/modules/onboarding/startup.service.js";
import type { StartupPlan } from "../src/modules/onboarding/onboarding.types.js";

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
  runDoctor: vi.fn().mockResolvedValue({ status: "failed", reasons: ["MIGRATION_MISSING"] }),
}));

describe("startup-doctor-loop failure check", () => {
  const testEnvPath = path.resolve(process.cwd(), ".env.test-doctor-failure");

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

  it("should fail overall onboarding sequence if doctor check fails", async () => {
    const plan: StartupPlan = {
      lang: "ja",
      database: { provider: "postgres", url: "postgres://mock-host/db", startDocker: false },
      compile: { provider: "openai", openaiKey: "mock" },
      distillation: { provider: "local-llm", findCandidateProvider: "openai" },
      embedding: { provider: "auto" },
      project: { wikiRoot: "wiki/pages", importSeed: false },
      mcpClient: "generic",
    };

    const res = await runStartupSeq(plan, { dryRun: false, envPath: testEnvPath });
    expect(res.ok).toBe(false); // Overall onboarding sequence must be failed because doctor failed

    const doctorStep = res.steps.find((s) => s.step === "doctor-validation");
    expect(doctorStep?.status).toBe("failed");
    expect(doctorStep?.message).toContain("Doctor check returned status: failed");
  });
});
