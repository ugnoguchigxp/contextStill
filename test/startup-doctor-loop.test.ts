import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StartupPlan } from "../src/modules/onboarding/onboarding.types.js";
import { runStartupSeq } from "../src/modules/onboarding/startup.service.js";

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
  checkPlanLlmHealth: vi
    .fn()
    .mockResolvedValue({ ok: true, provider: "openai", message: "healthy" }),
}));

vi.mock("../src/modules/doctor/doctor.service.js", () => ({
  runDoctor: vi.fn().mockImplementation(async () => {
    if ((globalThis as { __startupDoctorThrows?: boolean }).__startupDoctorThrows) {
      throw new Error("doctor boom");
    }
    return { status: "failed", reasons: ["MIGRATION_MISSING"] };
  }),
}));

describe("startup-doctor-loop failure check", () => {
  const testEnvPath = path.resolve(process.cwd(), ".env.test-doctor-failure");

  beforeEach(() => {
    if (existsSync(testEnvPath)) {
      rmSync(testEnvPath);
    }
    (globalThis as { __startupDoctorThrows?: boolean }).__startupDoctorThrows = false;
  });

  afterEach(() => {
    if (existsSync(testEnvPath)) {
      rmSync(testEnvPath);
    }
    (globalThis as { __startupDoctorThrows?: boolean }).__startupDoctorThrows = false;
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

  it("should restore process.env when doctor execution throws", async () => {
    const originalProvider = process.env.MEMORY_ROUTER_AGENTIC_COMPILE_PROVIDER;
    process.env.MEMORY_ROUTER_AGENTIC_COMPILE_PROVIDER = "openai";
    (globalThis as { __startupDoctorThrows?: boolean }).__startupDoctorThrows = true;
    try {
      const plan: StartupPlan = {
        lang: "ja",
        database: { provider: "postgres", url: "postgres://mock-host/db", startDocker: false },
        compile: {
          provider: "local-llm",
          localLlmBaseUrl: "http://127.0.0.1:44448",
          localLlmModel: "test-model",
        },
        distillation: { provider: "local-llm", findCandidateProvider: "local-llm" },
        embedding: { provider: "auto" },
        project: { wikiRoot: "wiki/pages", importSeed: false },
        mcpClient: "generic",
      };

      const res = await runStartupSeq(plan, { dryRun: false, envPath: testEnvPath });

      expect(res.ok).toBe(false);
      expect(process.env.MEMORY_ROUTER_AGENTIC_COMPILE_PROVIDER).toBe("openai");
    } finally {
      if (originalProvider === undefined) {
        process.env.MEMORY_ROUTER_AGENTIC_COMPILE_PROVIDER = undefined;
      } else {
        process.env.MEMORY_ROUTER_AGENTIC_COMPILE_PROVIDER = originalProvider;
      }
    }
  });
});
