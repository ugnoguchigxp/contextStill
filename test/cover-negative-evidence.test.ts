import { beforeEach, describe, expect, test, vi } from "vitest";
import { runCoverEvidence } from "../src/modules/coverEvidence/domain.js";
import { runCoverNegativeEvidence } from "../src/modules/coverNegativeEvidence/domain.js";
import { parseNegativeEvidenceResult } from "../src/modules/coverNegativeEvidence/parser.js";
import { getFindCandidateResultById } from "../src/modules/findCandidate/repository.js";

vi.mock("../src/modules/findCandidate/repository.js", () => ({
  getFindCandidateResultById: vi.fn(),
}));

vi.mock("../src/modules/audit/audit-log.service.js", () => ({
  recordAuditLogSafe: vi.fn(),
  auditEventTypes: {
    coverEvidenceStarted: "coverEvidenceStarted",
    coverEvidenceCompleted: "coverEvidenceCompleted",
  },
}));

vi.mock("../src/modules/settings/settings.service.js", () => ({
  ensureRuntimeSettingsLoaded: vi.fn(),
  resolveCoverEvidenceRoutes: vi.fn().mockReturnValue({
    sourceSupport: { provider: "openai", fallback: [] },
    externalEvidence: { provider: "openai", fallback: [] },
    mcpEvidence: { provider: "openai", providerPolicy: "default", fallback: [] },
  }),
}));

vi.mock("../src/modules/coverEvidence/provider-policy.js", () => ({
  resolveCoverEvidenceRouteByPolicy: vi.fn().mockReturnValue({
    provider: "openai",
    fallback: [],
  }),
}));

describe("cover-negative-evidence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("parses appliesTo facets from negative evidence JSON", () => {
    const parsed = parseNegativeEvidenceResult(
      JSON.stringify({
        status: "ready",
        polarity: "negative",
        intentTags: "failure_pattern, guardrail",
        appliesTo: {
          technologies: "typescript, vitest",
          changeTypes: ["diagnosis"],
          domains: ["queue", "distillation"],
          repoPath: "/repo",
          general: false,
        },
        distilled: {
          failure: "Stale queue status was treated as current truth.",
        },
        evidence: ["queue status was stale"],
        originRefs: ["review:finding-1"],
      }),
    );

    expect(parsed.appliesTo).toEqual({
      general: false,
      technologies: ["typescript", "vitest"],
      changeTypes: ["diagnosis"],
      domains: ["queue", "distillation"],
      repoPath: "/repo",
    });
    expect(parsed.intentTags).toEqual(["failure_pattern", "guardrail"]);
  });

  test("uses candidate metadata appliesTo as fallback when parsed result omits it", async () => {
    const mockChatClient = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        status: "ready",
        polarity: "negative",
        intentTags: ["failure_pattern"],
        distilled: {
          failure: "Stale queue status was trusted without checking events.",
        },
        evidence: ["status row was stale"],
        originRefs: ["review:finding-2"],
      }),
      toolCalls: [],
    });

    const result = await runCoverNegativeEvidence({
      id: "cand-2",
      write: false,
      chatClient: mockChatClient as any,
      candidate: {
        id: "cand-2",
        title: "Do not trust stale queue status alone",
        content: "Failure: stale queue status was trusted.",
        sourceUri: "review:finding-2",
        metadata: {
          appliesTo: {
            technologies: ["typescript"],
            changeTypes: ["diagnosis"],
            domains: ["queue"],
          },
        },
      },
    });

    expect(result.result.candidate).toEqual(
      expect.objectContaining({
        technologies: ["typescript"],
        changeTypes: ["diagnosis"],
        domains: ["queue"],
      }),
    );
    expect((result.result.toolEvents[0].metadata as any).appliesTo).toEqual({
      technologies: ["typescript"],
      changeTypes: ["diagnosis"],
      domains: ["queue"],
    });
  });

  test("does not mark ready negative evidence as knowledge_ready without required facets", async () => {
    const mockChatClient = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        status: "ready",
        polarity: "negative",
        intentTags: ["failure_pattern"],
        distilled: {
          failure: "Stale queue status was trusted without checking events.",
        },
        evidence: ["status row was stale"],
        originRefs: ["review:finding-3"],
      }),
      toolCalls: [],
    });

    const result = await runCoverNegativeEvidence({
      id: "cand-3",
      write: false,
      chatClient: mockChatClient as any,
      candidate: {
        id: "cand-3",
        title: "Do not trust stale queue status alone",
        content: "Failure: stale queue status was trusted.",
        sourceUri: "review:finding-3",
      },
    });

    expect(result.result.status).toBe("insufficient");
    expect(result.result.reason).toBe("applies_to_categories_required");
    expect(result.result.candidate).toBeNull();
    expect((result.result.toolEvents[0].metadata as any).appliesTo).toBeUndefined();
  });

  test("routes negative candidate to runCoverNegativeEvidence", async () => {
    const mockCandidate = {
      id: "cand-1",
      title: "Prohibit hardcoded API urls",
      content: "Failure: Hardcoded API host found in production config",
      status: "selected",
      targetKind: "knowledge_candidate",
      origin: {
        polarity: "negative",
        intentTags: ["security_risk"],
      },
    };
    vi.mocked(getFindCandidateResultById).mockResolvedValue(mockCandidate as any);

    const mockChatClient = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        status: "ready",
        polarity: "negative",
        intentTags: ["security_risk", "guardrail"],
        appliesTo: {
          technologies: ["runtime-config"],
          changeTypes: ["configuration"],
          domains: ["security"],
          general: false,
        },
        distilled: {
          failure: "Hardcoded API host in production config",
          impact: "Security risk",
          trigger: "Production configuration file edits",
          fix: "Use environment variables",
          verification: "Run secrets-scan tool",
          decisionSignal: "escalate",
        },
        evidence: ["Hardcoded API host found"],
        originRefs: ["manual_review:finding-001"],
      }),
      toolCalls: [],
    });

    const result = await runCoverEvidence({
      id: "cand-1",
      write: false,
      chatClient: mockChatClient as any,
    });

    expect(result.id).toBe("cand-1");
    expect(result.result.status).toBe("knowledge_ready");
    expect(result.result.candidate).toBeDefined();
    expect(result.result.candidate?.title).toBe("Prohibit hardcoded API urls");
    expect(result.result.candidate).toEqual(
      expect.objectContaining({
        applicabilityGeneral: false,
        technologies: ["runtime-config"],
        changeTypes: ["configuration"],
        domains: ["security"],
      }),
    );
    expect(result.result.candidate?.body).toContain(
      "Failure: Hardcoded API host in production config",
    );
    expect(result.result.toolEvents[0].name).toBe("negative_coverage");
    expect((result.result.toolEvents[0].metadata as any).polarity).toBe("negative");
    expect((result.result.toolEvents[0].metadata as any).intentTags).toContain("security_risk");
    expect((result.result.toolEvents[0].metadata as any).appliesTo).toEqual({
      general: false,
      technologies: ["runtime-config"],
      changeTypes: ["configuration"],
      domains: ["security"],
    });
  });
});
