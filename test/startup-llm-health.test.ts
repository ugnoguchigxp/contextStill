import { describe, expect, it, vi } from "vitest";
import { checkPlanLlmHealth } from "../src/modules/onboarding/llm-health.service.js";
import type { StartupPlan } from "../src/modules/onboarding/onboarding.types.js";

// Mock the core health check function so we don't hit live endpoints
vi.mock("../src/modules/llm/agentic-llm.service.js", () => ({
  checkAgenticLlmHealth: vi.fn().mockImplementation(async (provider: string) => {
    if (provider === "openai") {
      return { reachable: true, configured: true };
    }
    return { reachable: false, configured: true, error: "Connection timed out" };
  }),
}));

describe("startup-llm-health", () => {
  it("should return ok for a healthy provider", async () => {
    const plan: StartupPlan = {
      lang: "ja",
      database: { provider: "postgres", url: "postgres://db", startDocker: false },
      compile: { provider: "openai", openaiKey: "valid" },
      distillation: { provider: "local-llm", findCandidateProvider: "openai" },
      embedding: { provider: "auto" },
      project: { wikiRoot: "wiki/pages", importSeed: true },
      mcpClient: "generic",
    };

    const res = await checkPlanLlmHealth(plan);
    expect(res.ok).toBe(true);
    expect(res.provider).toBe("openai");
  });

  it("should return not ok for an unhealthy provider", async () => {
    const plan: StartupPlan = {
      lang: "ja",
      database: { provider: "postgres", url: "postgres://db", startDocker: false },
      compile: { provider: "bedrock", bedrockModel: "invalid" },
      distillation: { provider: "local-llm", findCandidateProvider: "openai" },
      embedding: { provider: "auto" },
      project: { wikiRoot: "wiki/pages", importSeed: true },
      mcpClient: "generic",
    };

    const res = await checkPlanLlmHealth(plan);
    expect(res.ok).toBe(false);
    expect(res.provider).toBe("bedrock");
    expect(res.message).toContain("Connection timed out");
  });
});
