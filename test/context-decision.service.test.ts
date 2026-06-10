import { beforeEach, describe, expect, test, vi } from "vitest";
import { decideContext } from "../src/modules/context-decision/context-decision.service.js";
import type { KnowledgeSearchResult } from "../src/modules/knowledge/knowledge.repository.js";

// モック定義
const mockSearchKnowledge = vi.fn();
const mockGetRelatedDecisionBadSignalCount = vi.fn();
const mockListContextDecisionMlTrainingRows = vi.fn();
const mockInsertContextDecisionRun = vi.fn();
const mockInsertContextDecisionEvidenceRows = vi.fn();
const mockInsertContextDecisionCoverageRows = vi.fn();

vi.mock("../src/modules/knowledge/knowledge.repository.js", () => ({
  searchKnowledge: (...args: any[]) => mockSearchKnowledge(...args),
}));

vi.mock("../src/modules/context-decision/context-decision.repository.js", () => ({
  getRelatedDecisionBadSignalCount: (...args: any[]) =>
    mockGetRelatedDecisionBadSignalCount(...args),
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
    mockGetRelatedDecisionBadSignalCount.mockResolvedValue(0);
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

  test("decideContext returns execute decision when LLM responds successfully", async () => {
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
          content: "決定は execute です。ダミールールに合致しています。",
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

    expect(result.decision).toBe("execute");
    // LLM の confidence ではなく、決定論的にクランプされた scored.trace.finalConfidence (71) が返る
    expect(result.confidence).toBe(71);
    expect(result.agentMessage).toContain("決定は execute です");
    expect(mockInsertContextDecisionRun).toHaveBeenCalled();
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
});
