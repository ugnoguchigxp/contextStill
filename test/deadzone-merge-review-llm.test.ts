import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  DeadZoneMergeReviewParseError,
  runDeadZoneMergeReviewLlm,
} from "../src/modules/landscape/deadzone-merge-review-llm.js";

// config モック
vi.mock("../src/config.js", () => ({
  groupedConfig: {
    localLlm: {
      model: "local-model",
    },
    distillation: {
      coverEvidenceTimeoutMs: 10000,
    },
  },
}));

// settings service モック
const mockResolveDeadZoneMergeReviewRoute = vi.fn();
vi.mock("../src/modules/settings/settings.service.js", () => ({
  resolveDeadZoneMergeReviewRoute: (...args: any[]) => mockResolveDeadZoneMergeReviewRoute(...args),
}));

// distillation runtime モック
const mockRunDistillationCompletion = vi.fn();
const mockResolveRouteModelForProvider = vi.fn();
vi.mock("../src/modules/distillation/distillation-runtime.service.js", () => ({
  runDistillationCompletion: (...args: any[]) => mockRunDistillationCompletion(...args),
  resolveRouteModelForProvider: (...args: any[]) => mockResolveRouteModelForProvider(...args),
}));

describe("deadzone-merge-review-llm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveDeadZoneMergeReviewRoute.mockReturnValue({
      provider: "openai",
      model: "gpt-4",
      fallback: [],
      azureDeploymentSlots: undefined,
      localLlmModel: undefined,
    });
    mockResolveRouteModelForProvider.mockImplementation(
      (params: { routeModel?: string; localLlmModel?: string }) =>
        params.localLlmModel ?? params.routeModel ?? "local-model",
    );
  });

  const dummyInputSnapshot = {
    deadZone: {
      id: "dz-1",
      title: "DZ",
      body: "DZ Body",
      type: "rule",
      status: "active",
      appliesTo: {},
      bodyHash: "h1",
    },
    canonical: {
      id: "ca-1",
      title: "CA",
      body: "CA Body",
      type: "rule",
      status: "active",
      appliesTo: {},
      bodyHash: "h2",
    },
    heuristicRecommendation: {
      confidence: "high",
      reasons: [],
      blockers: [],
    },
  };

  test("throws DeadZoneMergeReviewParseError if response does not contain JSON", async () => {
    mockRunDistillationCompletion.mockResolvedValue({
      content: "This is a plain text response without JSON markers.",
    });

    await expect(runDeadZoneMergeReviewLlm({ inputSnapshot: dummyInputSnapshot })).rejects.toThrow(
      DeadZoneMergeReviewParseError,
    );
  });

  test("throws DeadZoneMergeReviewParseError if JSON parse fails", async () => {
    mockRunDistillationCompletion.mockResolvedValue({
      content: "```json\n{ invalid-json: }\n```",
    });

    await expect(runDeadZoneMergeReviewLlm({ inputSnapshot: dummyInputSnapshot })).rejects.toThrow(
      DeadZoneMergeReviewParseError,
    );
  });

  test("throws DeadZoneMergeReviewParseError if result schema validation fails", async () => {
    mockRunDistillationCompletion.mockResolvedValue({
      content: JSON.stringify({
        decision: "invalid_decision", // invalid enum
        confidence: "high",
        rationale: [],
        blockers: [],
        proposedCanonicalBody: "body",
        proposedSummary: "summary",
      }),
    });

    await expect(runDeadZoneMergeReviewLlm({ inputSnapshot: dummyInputSnapshot })).rejects.toThrow(
      DeadZoneMergeReviewParseError,
    );
  });

  test("successfully parses and validates merge review result", async () => {
    const validResult = {
      decision: "merge_recommended",
      confidence: "high" as const,
      rationale: ["reasons"],
      blockers: [],
      proposedCanonicalBody: "New Unified Body",
      proposedSummary: "Merged Summary",
    };

    mockRunDistillationCompletion.mockResolvedValue({
      content: JSON.stringify(validResult),
    });

    const result = await runDeadZoneMergeReviewLlm({ inputSnapshot: dummyInputSnapshot });

    expect(result.decision).toBe("merge_recommended");
    expect(result.confidence).toBe("high");
    expect(result.proposedCanonicalBody).toBe("New Unified Body");
    expect(result.parseStatus).toBe("parsed");
    expect(result.rawOutputExcerpt).toBe(JSON.stringify(validResult));
  });
});
