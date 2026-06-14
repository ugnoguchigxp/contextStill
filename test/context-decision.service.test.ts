import { beforeEach, describe, expect, test, vi } from "vitest";
import { decideContext } from "../src/modules/context-decision/context-decision.service.js";
import type { KnowledgeSearchResult } from "../src/modules/knowledge/knowledge.repository.js";

// モック定義
const mockSearchKnowledge = vi.fn();
const mockGetRelatedDecisionBadSignalSummary = vi.fn();
const mockListContextDecisionMlTrainingRows = vi.fn();
const mockInsertContextDecisionRun = vi.fn();
const mockInsertContextDecisionEvidenceRows = vi.fn();
const mockInsertContextDecisionCoverageRows = vi.fn();

vi.mock("../src/modules/knowledge/knowledge.repository.js", () => ({
  searchKnowledge: (...args: any[]) => mockSearchKnowledge(...args),
}));

vi.mock("../src/modules/context-decision/context-decision.repository.js", () => ({
  getRelatedDecisionBadSignalSummary: (...args: any[]) =>
    mockGetRelatedDecisionBadSignalSummary(...args),
  listContextDecisionMlTrainingRows: (...args: any[]) =>
    mockListContextDecisionMlTrainingRows(...args),
  insertContextDecisionRun: (...args: any[]) => mockInsertContextDecisionRun(...args),
  insertContextDecisionEvidenceRows: (...args: any[]) =>
    mockInsertContextDecisionEvidenceRows(...args),
  insertContextDecisionCoverageRows: (...args: any[]) =>
    mockInsertContextDecisionCoverageRows(...args),
}));

// settings.service.js のモック
const mockEnsureRuntimeSettingsLoaded = vi.fn();
const mockResolveAgenticCompileRouting = vi.fn();
vi.mock("../src/modules/settings/settings.service.js", () => ({
  ensureRuntimeSettingsLoaded: () => mockEnsureRuntimeSettingsLoaded(),
  resolveAgenticCompileRouting: () => mockResolveAgenticCompileRouting(),
}));

// agentic-llm.service.js のモック
const mockGetAgenticLlmProviders = vi.fn();
vi.mock("../src/modules/llm/agentic-llm.service.js", () => ({
  getAgenticLlmProviders: () => mockGetAgenticLlmProviders(),
}));

function createDummyKnowledge(
  overrides: Partial<KnowledgeSearchResult> = {},
): KnowledgeSearchResult {
  return {
    id: "kb-1",
    type: "rule",
    status: "active",
    scope: "repo",
    polarity: overrides.polarity ?? "positive",
    intentTags: overrides.intentTags ?? [],
    title: "Dummy Rule",
    body: "This is a test rule body.",
    confidence: 90,
    importance: 80,
    score: 0.9,
    appliesTo: {},
    metadata: {},
    sourceRefs: ["file:///dummy.md#line:1"],
    hasSourceLinks: true,
    dynamicScore: 90,
    compileSelectCount: 1,
    agenticAcceptCount: 0,
    explicitUpvoteCount: 0,
    explicitDownvoteCount: 0,
    lastCompiledAt: null,
    lastVerifiedAt: null,
    updatedAt: new Date(),
    decayFactor: 1,
    applicabilityScore: 30,
    applicabilityMatches: { technologies: [], changeTypes: [], domains: [], general: true },
    ...overrides,
  };
}

describe("context-decision.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // デフォルトのモック設定
    mockGetRelatedDecisionBadSignalSummary.mockResolvedValue({
      count: 0,
      strongCount: 0,
      averageConfidence: 0,
      maxConfidence: 0,
    });
    mockListContextDecisionMlTrainingRows.mockResolvedValue([]);
    mockInsertContextDecisionRun.mockResolvedValue("decision-run-id-123");
    mockResolveAgenticCompileRouting.mockReturnValue({
      enabled: true,
      provider: "mock-llm",
      timeoutMs: 5000,
      fallback: "local-llm",
      azureDeploymentSlots: [],
    });
  });

  test("decideContext constrains direct execute when coverage is weak", async () => {
    // クエリに応じたナレッジ返却。supportのみヒットさせる。
    mockSearchKnowledge.mockImplementation(async (params: any) => {
      const q = params.query.toLowerCase();
      if (q.includes("safe to execute") || q.includes("proceed")) {
        return [createDummyKnowledge({ id: "kb-support", title: "Standard Support Rule" })];
      }
      return [];
    });

    // LLM プロバイダのモック
    const mockLlmProvider = {
      isConfigured: () => true,
      chat: vi
        .fn()
        .mockResolvedValueOnce({
          // structuredLlmJudgment 用のレスポンス
          content: JSON.stringify({
            decision: "execute",
            confidence: 95,
            mandate: "Proceed with the change",
            selectedAction: "run main script",
            rejectedActions: [],
            reasoningSummary: "Good support, no risk found.",
            evidenceInterpretation: [
              {
                title: "Standard Support Rule",
                classification: "execution_support",
                appliesToProposedAction: true,
                effectOnDecision: "supports execute",
              },
            ],
          }),
        })
        .mockResolvedValueOnce({
          // composeAgentMessage 用のレスポンス
          content: "決定は revise_and_execute です。追加確認してから進めます。",
        }),
    };
    mockGetAgenticLlmProviders.mockResolvedValue([mockLlmProvider]);

    const input = {
      decisionPoint: "verify code implementation",
      retrievalHints: {
        technologies: ["typescript"],
        changeTypes: ["chore"],
        domains: ["testing"],
      },
      metadata: {},
    };

    const result = await decideContext(input);

    expect(result.decision).toBe("revise_and_execute");
    expect(result.confidence).toBe(68);
    expect(result.agentMessage).toContain("決定は revise_and_execute です");
    const answerPrompt = mockLlmProvider.chat.mock.calls[1]?.[0]?.messages?.[1]?.content as string;
    expect(answerPrompt).toContain("Reliability Gate trace:");
    expect(answerPrompt).toContain("weak_coverage_requires_revision");
    expect(mockInsertContextDecisionRun).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "revise_and_execute",
        confidenceTrace: expect.objectContaining({
          reliabilityGate: expect.objectContaining({
            status: "constrained",
            originalDecision: "execute",
            finalDecision: "revise_and_execute",
          }),
        }),
      }),
    );
    expect(mockInsertContextDecisionEvidenceRows).toHaveBeenCalled();
    expect(mockInsertContextDecisionCoverageRows).toHaveBeenCalled();
  });

  test("decideContext falls back to deterministic decision when LLM fails", async () => {
    // support はなし
    mockSearchKnowledge.mockResolvedValue([]);

    // LLM 呼び出しをすべて失敗させる
    const mockLlmProvider = {
      isConfigured: () => true,
      chat: vi.fn().mockRejectedValue(new Error("LLM Connection Failed")),
    };
    mockGetAgenticLlmProviders.mockResolvedValue([mockLlmProvider]);

    const input = {
      decisionPoint: "verify code implementation",
      retrievalHints: {
        technologies: ["typescript"],
        changeTypes: ["chore"],
        domains: ["testing"],
      },
      metadata: {},
    };

    const result = await decideContext(input);

    expect(result.decision).toBeDefined();
    expect(result.confidence).toBeDefined();
    expect(result.agentMessage).toContain("判断は");
    expect(mockInsertContextDecisionRun).toHaveBeenCalled();
  });

  test("decideContext handles LLM repair flow when JSON is malformed", async () => {
    mockSearchKnowledge.mockImplementation(async (params: any) => {
      const q = params.query.toLowerCase();
      if (q.includes("safe to execute") || q.includes("proceed")) {
        return [createDummyKnowledge({ id: "kb-support", title: "Standard Support Rule" })];
      }
      return [];
    });

    const mockLlmProvider = {
      isConfigured: () => true,
      chat: vi
        .fn()
        .mockResolvedValueOnce({
          // 1回目：壊れた JSON
          content: "invalid-json-content",
        })
        .mockResolvedValueOnce({
          // 2回目：修復された JSON
          // Knowledge Assessment推奨値(execute)と異なる決定を返すため、
          // reasoningSummary に "override" という文字列を含める必要がある。
          content: JSON.stringify({
            decision: "revise_and_execute",
            confidence: 80,
            mandate: "Revise tests before execution",
            selectedAction: "run main script",
            rejectedActions: [],
            reasoningSummary: "Need to fix minor things. Assessment override.",
            evidenceInterpretation: [],
          }),
        })
        .mockResolvedValueOnce({
          // composeAgentMessage 用
          content: "決定は revise_and_execute です。",
        }),
    };
    mockGetAgenticLlmProviders.mockResolvedValue([mockLlmProvider]);

    const input = {
      decisionPoint: "verify code implementation",
      retrievalHints: {
        technologies: ["typescript"],
        changeTypes: ["chore"],
        domains: ["testing"],
      },
      metadata: {},
    };

    const result = await decideContext(input);

    expect(result.decision).toBe("revise_and_execute");
    expect(result.confidence).toBe(71); // scored.trace.finalConfidence
    expect(result.agentMessage).toBe("決定は revise_and_execute です。");
  });

  test("decideContext triggers override safety alignment when LLM overrides Knowledge Assessment but reasoning summary is missing required override explanation", async () => {
    // ナレッジは何もヒットさせない（これによりアセスメント推奨値は "escalate" になる）
    mockSearchKnowledge.mockResolvedValue([]);

    const mockLlmProvider = {
      isConfigured: () => true,
      chat: vi
        .fn()
        .mockResolvedValueOnce({
          // Knowledge Assessment と異なる決定 (例: LLM が execute、Assessment が escalate) を返す。
          // reasoningSummary に "override" や "Assessment" などのキーワードを含めないケース。
          content: JSON.stringify({
            decision: "execute",
            confidence: 90,
            mandate: "Force execute",
            selectedAction: "run main script",
            rejectedActions: [],
            reasoningSummary: "Everything is perfect.", // override説明が欠如
            evidenceInterpretation: [],
          }),
        })
        .mockResolvedValueOnce({
          // composeAgentMessage 用
          content: "決定はフォールバックされました。",
        }),
    };
    mockGetAgenticLlmProviders.mockResolvedValue([mockLlmProvider]);

    const input = {
      decisionPoint: "verify code implementation",
      retrievalHints: {
        technologies: ["typescript"],
        changeTypes: ["chore"],
        domains: ["testing"],
      },
      metadata: {},
    };

    const result = await decideContext(input);

    // override説明がないため、フォールバック判断（assessmentAlignedFallbackJudgment）が適用され、
    // recommendedDirection である "escalate" が返ってくる。
    expect(result.decision).toBe("escalate");
  });

  test("passes high-scoring negative knowledge from any coverage role as risk context to the LLM", async () => {
    const negativeKnowledge = createDummyKnowledge({
      id: "kb-negative",
      polarity: "negative",
      title: "Do not skip migration verification",
      body: "Do not proceed unless migration verification has been run.",
      score: 0.96,
      confidence: 95,
      importance: 90,
      applicabilityScore: 35,
    });
    const supportKnowledge = createDummyKnowledge({
      id: "kb-support",
      title: "Use existing migration procedure",
      body: "Use the existing migration procedure when changing schema code.",
      score: 0.9,
    });
    mockSearchKnowledge.mockImplementation(async (params: any) => {
      const q = params.query.toLowerCase();
      if (q.includes("counterexample") || q.includes("failure condition")) {
        return [negativeKnowledge];
      }
      if (q.includes("safe to execute") || q.includes("proceed")) {
        return [supportKnowledge];
      }
      return [];
    });

    const chat = vi
      .fn()
      .mockResolvedValueOnce({
        content: JSON.stringify({
          decision: "reject",
          confidence: 84,
          mandate: "Do not proceed before migration verification.",
          selectedAction: null,
          rejectedActions: ["execute"],
          reasoningSummary:
            "Knowledge Assessment agrees that the negative verification constraint applies.",
          evidenceInterpretation: [
            {
              title: "Do not skip migration verification",
              classification: "prohibition_or_constraint",
              appliesToProposedAction: true,
              effectOnDecision: "weighs against execute",
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        content: "判断は reject です。migration verification を先に確認してください。",
      });
    mockGetAgenticLlmProviders.mockResolvedValue([{ isConfigured: () => true, chat }]);

    const result = await decideContext({
      decisionPoint: "decide whether to continue migration change",
      retrievalHints: {
        technologies: ["typescript"],
        changeTypes: ["migration"],
        domains: ["database"],
      },
      metadata: {},
    });

    expect(result.decision).toBe("reject");
    expect(mockInsertContextDecisionEvidenceRows).toHaveBeenCalledWith(
      "decision-run-id-123",
      expect.arrayContaining([
        expect.objectContaining({
          knowledgeId: "kb-negative",
          role: "risk_warning",
          summary: expect.stringContaining("Do not skip migration verification"),
        }),
      ]),
    );
    const firstPrompt = chat.mock.calls[0]?.[0]?.messages?.[1]?.content as string;
    const firstSystemPrompt = chat.mock.calls[0]?.[0]?.messages?.[0]?.content as string;
    expect(firstSystemPrompt).toContain(
      "Knowledge with role=risk_warning or polarity=negative is negative evidence, not reference-only context.",
    );
    expect(firstSystemPrompt).toContain("it must weigh against execute");
    expect(firstPrompt).toContain("Risk Knowledge:");
    expect(firstPrompt).toContain("Do not skip migration verification");
    expect(firstPrompt).toContain("Do not proceed unless migration verification has been run.");
  });

  test("decideContext returns deterministic judgment when Agentic Compile Routing is disabled", async () => {
    mockResolveAgenticCompileRouting.mockReturnValueOnce({
      enabled: false,
      provider: "mock-llm",
      timeoutMs: 5000,
      fallback: "local-llm",
      azureDeploymentSlots: [],
    });

    const input = {
      decisionPoint: "verify code implementation",
      retrievalHints: {},
      metadata: {},
    };

    const result = await decideContext(input);

    expect(result.decision).toBeDefined();
    expect(result.agentMessage).toContain("判断は");
  });

  test("decideContext handles searchKnowledge throwing an error gracefully", async () => {
    mockSearchKnowledge.mockRejectedValueOnce(new Error("Database connection error"));

    const input = {
      decisionPoint: "verify code implementation",
      retrievalHints: {
        technologies: ["typescript"],
      },
    };

    await expect(decideContext(input)).rejects.toThrow("Database connection error");
  });
});
