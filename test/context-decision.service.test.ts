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
const mockMarkContextDecisionRunFailed = vi.fn();
const mockLoadDecisionSignalBundles = vi.fn();
const mockSearchEpisodes = vi.fn();
const mockRecordEpisodeUsage = vi.fn();

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
  markContextDecisionRunFailed: (...args: any[]) => mockMarkContextDecisionRunFailed(...args),
}));

vi.mock("../src/modules/context-decision/context-decision.signals.repository.js", () => ({
  loadDecisionSignalBundles: (...args: any[]) => mockLoadDecisionSignalBundles(...args),
}));

vi.mock("../src/modules/episodic-memory/episode-card.service.js", () => ({
  searchEpisodes: (...args: any[]) => mockSearchEpisodes(...args),
  recordEpisodeUsage: (...args: any[]) => mockRecordEpisodeUsage(...args),
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
    body: "Proceed with the TypeScript implementation when verification evidence supports the current decision.",
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

function createDummyEpisode(overrides: Record<string, unknown> = {}) {
  return {
    id: "episode-1",
    title: "Migration failure precedent",
    situation: "A similar implementation failed verification.",
    observations: "",
    action: "The agent revised scope before continuing.",
    outcome: "The risk was avoided.",
    lesson: "Revise implementation when direct verification is missing.",
    applicability: {},
    antiApplicability: {},
    domains: ["decision"],
    technologies: ["typescript"],
    changeTypes: ["implementation"],
    tools: [],
    repoPath: null,
    repoKey: null,
    sourceKind: "manual",
    sourceKey: "episode-1",
    outcomeKind: "failure",
    importance: 80,
    confidence: 90,
    compileUseCount: 0,
    decisionUseCount: 0,
    status: "active",
    staleAt: null,
    metadata: {},
    createdAt: new Date("2026-06-20T00:00:00.000Z"),
    updatedAt: new Date("2026-06-20T00:00:00.000Z"),
    score: 15,
    refs: [],
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
    mockInsertContextDecisionEvidenceRows.mockResolvedValue(undefined);
    mockInsertContextDecisionCoverageRows.mockResolvedValue(undefined);
    mockMarkContextDecisionRunFailed.mockResolvedValue(undefined);
    mockLoadDecisionSignalBundles.mockResolvedValue({
      status: "complete",
      reason: "test signals",
      bundles: new Map(),
    });
    mockSearchEpisodes.mockResolvedValue([]);
    mockRecordEpisodeUsage.mockResolvedValue(undefined);
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
      if (q.includes("safe to execute")) {
        return [
          createDummyKnowledge({
            id: "kb-support",
            title: "Standard Support Rule",
            body: "Verify code implementation with TypeScript chore testing evidence, then safe execute and proceed.",
            score: 1,
            applicabilityScore: 100,
          }),
        ];
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
    expect(result.confidence).toBe(55);
    expect(result.agentMessage).toContain("判断は revise_and_execute です");
    expect(result.agentMessage).toContain("根拠が限定的");
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

  test("keeps decision answer text beyond the old short truncation limit", async () => {
    mockSearchKnowledge.mockImplementation(async (params: any) => {
      const q = params.query.toLowerCase();
      if (q.includes("safe to execute")) {
        return [
          createDummyKnowledge({
            id: "kb-support-long-answer",
            title: "Long answer support rule",
            body: "Use when verifying code implementation with bounded safeguards. Continue only after the TypeScript verification condition is checked for this code implementation.",
            score: 1,
            applicabilityScore: 100,
          }),
        ];
      }
      return [];
    });

    const longAnswer = `判断は revise_and_execute です。${"検証条件を確認してから、狭い範囲で判断を進める必要があります。".repeat(55)}`;
    expect(longAnswer.length).toBeGreaterThan(1200);
    expect(longAnswer.length).toBeLessThan(2000);
    const chat = vi
      .fn()
      .mockResolvedValueOnce({
        content: JSON.stringify({
          decision: "revise_and_execute",
          confidence: 95,
          mandate: "Verify with bounded safeguards before execution",
          selectedAction: "verify with bounded safeguards",
          rejectedActions: [],
          reasoningSummary:
            "Knowledge Assessment override: support exists, but bounded safeguards should be verified first.",
          evidenceInterpretation: [
            {
              title: "Long answer support rule",
              classification: "execution_support",
              adoption: "adopted",
              similarityToDecision: "same bounded TypeScript verification context",
              appliesToProposedAction: true,
              effectOnDecision: "supports execute",
            },
          ],
        }),
      })
      .mockResolvedValueOnce({ content: longAnswer });
    mockGetAgenticLlmProviders.mockResolvedValue([{ isConfigured: () => true, chat }]);

    const result = await decideContext({
      decisionPoint: "verify code implementation with bounded safeguards",
      retrievalHints: {
        technologies: ["typescript"],
        changeTypes: ["chore"],
        domains: ["testing"],
      },
      metadata: {},
    });

    expect(result.agentMessage).toBe(longAnswer);
    expect(result.agentMessage.endsWith("...")).toBe(false);
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

  test("fallback answer records operational impact and autonomous GO rationale", async () => {
    mockSearchKnowledge.mockImplementation(async (params: any) => {
      const q = params.query.toLowerCase();
      if (q.includes("safe to execute")) {
        return [
          createDummyKnowledge({
            id: "kb-support-restart",
            title: "Restart support",
            body: "Process restarts can proceed when runtime impact is bounded and verification is available.",
            score: 1,
            applicabilityScore: 80,
          }),
        ];
      }
      if (q.includes("risk warning guardrail")) {
        return [
          createDummyKnowledge({
            id: "kb-risk-restart",
            title: "Restart guardrail",
            body: "Check active work and user impact before restarting long-running services.",
            polarity: "negative",
            score: 1,
            applicabilityScore: 80,
            confidence: 98,
            importance: 98,
          }),
        ];
      }
      return [];
    });
    mockGetAgenticLlmProviders.mockResolvedValue([]);

    const result = await decideContext({
      decisionPoint:
        "com.context-still.queue-supervisor LaunchAgent を unload/load してよいか判断する",
      retrievalHints: {
        technologies: ["LaunchAgent", "queue"],
        changeTypes: ["runtime"],
        domains: ["decision"],
      },
      metadata: {
        runtimeEvidence: {
          activeLeaseCount: 1,
          impactedUserEstimate: 0,
          runningQueue: "episodeDistiller",
          pendingEpisodeDistiller: 2099,
        },
      },
    });

    expect(result.decision).toBe("revise_and_execute");
    expect(result.agentMessage).toContain("GO with safeguards");
    expect(result.agentMessage).toContain("影響見積り");
    expect(result.agentMessage).toContain("activeLeaseCount=1");
    expect(result.agentMessage).toContain("impactedUserEstimate=0");
    expect(mockInsertContextDecisionRun).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "revise_and_execute",
        agentMessage: expect.stringContaining("GO with safeguards"),
        confidenceTrace: expect.objectContaining({
          reliabilityGate: expect.objectContaining({
            operationalImpact: expect.objectContaining({
              operationType: "process_restart",
              level: "medium",
              autonomousGoRecommended: true,
            }),
          }),
        }),
      }),
    );
  });

  test("decideContext handles LLM repair flow when JSON is malformed", async () => {
    mockSearchKnowledge.mockImplementation(async (params: any) => {
      const q = params.query.toLowerCase();
      if (q.includes("safe to execute")) {
        return [
          createDummyKnowledge({
            id: "kb-support",
            title: "Standard Support Rule",
            body: "Verify code implementation with TypeScript chore testing evidence, then safe execute and proceed.",
            score: 1,
            applicabilityScore: 100,
          }),
        ];
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
    expect(result.confidence).toBe(55); // capped by claimed/inferred primary evidence calibration
    expect(result.agentMessage).toContain("判断は revise_and_execute です");
    expect(result.agentMessage).toContain("根拠が限定的");
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
      if (q.includes("safe to execute")) {
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

  test("persists positive counter hits as first-class counter evidence", async () => {
    const supportKnowledge = createDummyKnowledge({
      id: "kb-support",
      title: "Support rule",
      body: "Continue implementation decision with TypeScript implementation decision evidence, then safe execute and proceed.",
      score: 0.9,
      applicabilityScore: 100,
    });
    const counterKnowledge = createDummyKnowledge({
      id: "kb-counter",
      title: "Counter rule",
      body: "A similar implementation previously required scope revision before execution.",
      polarity: "positive",
      score: 0.92,
    });
    mockSearchKnowledge.mockImplementation(async (params: any) => {
      const q = params.query.toLowerCase();
      if (q.includes("counterexample") || q.includes("failure condition")) {
        return [counterKnowledge];
      }
      if (q.includes("safe to execute")) {
        return [supportKnowledge];
      }
      return [];
    });

    const chat = vi
      .fn()
      .mockResolvedValueOnce({
        content: JSON.stringify({
          decision: "revise_and_execute",
          confidence: 76,
          mandate: "Revise scope before execution.",
          selectedAction: null,
          rejectedActions: ["execute"],
          reasoningSummary:
            "Knowledge Assessment override: counter evidence requires narrowing scope.",
          evidenceInterpretation: [],
        }),
      })
      .mockResolvedValueOnce({
        content: "判断は revise_and_execute です。counter evidence に合わせて範囲を絞ります。",
      });
    mockGetAgenticLlmProviders.mockResolvedValue([{ isConfigured: () => true, chat }]);

    const result = await decideContext({
      decisionPoint: "decide whether to continue implementation",
      retrievalHints: {
        technologies: ["typescript"],
        changeTypes: ["implementation"],
        domains: ["decision"],
      },
      metadata: {},
    });

    expect(result.decision).toBe("revise_and_execute");
    expect(mockInsertContextDecisionEvidenceRows).toHaveBeenCalledWith(
      "decision-run-id-123",
      expect.arrayContaining([
        expect.objectContaining({
          knowledgeId: "kb-counter",
          role: "counter_evidence",
        }),
      ]),
    );
    const judgmentPrompt = chat.mock.calls[0]?.[0]?.messages?.[1]?.content as string;
    expect(judgmentPrompt).toContain("Counter Evidence Knowledge:");
    expect(judgmentPrompt).toContain("Counter rule");
  });

  test("preserves selected risk and alternative roles even when knowledge polarity is positive", async () => {
    const supportKnowledge = createDummyKnowledge({
      id: "kb-support",
      title: "Support rule",
      body: "Continue implementation decision with TypeScript implementation decision evidence, then safe execute and proceed.",
      score: 0.9,
      applicabilityScore: 100,
    });
    const riskKnowledge = createDummyKnowledge({
      id: "kb-risk-positive",
      title: "Risk guardrail",
      body: "This guardrail should be reviewed before autonomous execution.",
      polarity: "positive",
      score: 0.94,
    });
    const alternativeKnowledge = createDummyKnowledge({
      id: "kb-alternative-positive",
      title: "Alternative path",
      body: "A previous similar change should have been split before execution.",
      polarity: "positive",
      score: 0.93,
    });
    mockSearchKnowledge.mockImplementation(async (params: any) => {
      const q = params.query.toLowerCase();
      if (q.includes("risk warning guardrail")) return [riskKnowledge];
      if (q.includes("alternative approach")) return [alternativeKnowledge];
      if (q.includes("safe to execute")) return [supportKnowledge];
      return [];
    });

    const chat = vi
      .fn()
      .mockResolvedValueOnce({
        content: JSON.stringify({
          decision: "execute",
          confidence: 88,
          mandate: "Proceed.",
          selectedAction: "run implementation",
          rejectedActions: [],
          reasoningSummary: "Knowledge Assessment agrees support is present.",
          evidenceInterpretation: [],
        }),
      })
      .mockResolvedValueOnce({
        content: "判断は revise_and_execute です。risk guardrail を確認してから進めます。",
      });
    mockGetAgenticLlmProviders.mockResolvedValue([{ isConfigured: () => true, chat }]);

    const result = await decideContext({
      decisionPoint: "decide whether to continue implementation",
      retrievalHints: {
        technologies: ["typescript"],
        changeTypes: ["implementation"],
        domains: ["decision"],
      },
      metadata: {},
    });

    expect(result.decision).toBe("revise_and_execute");
    expect(mockInsertContextDecisionEvidenceRows).toHaveBeenCalledWith(
      "decision-run-id-123",
      expect.arrayContaining([
        expect.objectContaining({
          knowledgeId: "kb-risk-positive",
          role: "risk_warning",
        }),
        expect.objectContaining({
          knowledgeId: "kb-alternative-positive",
          role: "rejected_alternative",
        }),
      ]),
    );
  });

  test("deduplicates the same knowledge id by decision role precedence", async () => {
    const sharedKnowledge = createDummyKnowledge({
      id: "kb-shared",
      title: "Shared counter rule",
      body: "The same rule can be retrieved by support, risk, and counter queries.",
      polarity: "positive",
      score: 0.96,
    });
    mockSearchKnowledge.mockImplementation(async (params: any) => {
      const q = params.query.toLowerCase();
      if (
        q.includes("safe to execute") ||
        q.includes("counterexample") ||
        q.includes("risk warning")
      ) {
        return [sharedKnowledge];
      }
      return [];
    });
    mockResolveAgenticCompileRouting.mockReturnValueOnce({
      enabled: false,
      provider: "mock-llm",
      timeoutMs: 5000,
      fallback: "local-llm",
      azureDeploymentSlots: [],
    });

    const result = await decideContext({
      decisionPoint: "decide whether to continue implementation",
      retrievalHints: {
        technologies: ["typescript"],
        changeTypes: ["implementation"],
        domains: ["decision"],
      },
      metadata: {},
    });

    expect(result.decision).toBe("revise_and_execute");
    const persistedEvidence = mockInsertContextDecisionEvidenceRows.mock.calls[0]?.[1] as Array<{
      knowledgeId: string | null;
      role: string;
    }>;
    expect(persistedEvidence.filter((item) => item.knowledgeId === "kb-shared")).toEqual([
      expect.objectContaining({
        knowledgeId: "kb-shared",
        role: "counter_evidence",
      }),
    ]);
  });

  test("constrains execute-like decisions when decision signal loading fails", async () => {
    const supportKnowledge = createDummyKnowledge({
      id: "kb-support",
      title: "Support rule",
      body: "Continue implementation decision with TypeScript implementation decision evidence, then safe execute and proceed.",
      score: 0.9,
      applicabilityScore: 100,
    });
    mockSearchKnowledge.mockImplementation(async (params: any) => {
      const q = params.query.toLowerCase();
      if (q.includes("safe to execute")) return [supportKnowledge];
      return [];
    });
    mockLoadDecisionSignalBundles.mockResolvedValueOnce({
      status: "failed",
      reason: "signal repository unavailable",
      bundles: new Map([["kb-support", {}]]),
    });

    const chat = vi
      .fn()
      .mockResolvedValueOnce({
        content: JSON.stringify({
          decision: "revise_and_execute",
          confidence: 91,
          mandate: "Revise and proceed.",
          selectedAction: "run implementation",
          rejectedActions: [],
          reasoningSummary: "Knowledge Assessment agrees support is present.",
          evidenceInterpretation: [],
        }),
      })
      .mockResolvedValueOnce({
        content: "判断は escalate です。decision signal を復旧してから判断します。",
      });
    mockGetAgenticLlmProviders.mockResolvedValue([{ isConfigured: () => true, chat }]);

    const result = await decideContext({
      decisionPoint: "decide whether to continue implementation",
      retrievalHints: {
        technologies: ["typescript"],
        changeTypes: ["implementation"],
        domains: ["decision"],
      },
      metadata: {},
    });

    expect(result.decision).toBe("escalate");
    expect(result.coverageSummary.degraded).toBe(true);
    expect(mockInsertContextDecisionRun).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "escalate",
        status: "degraded",
        confidenceTrace: expect.objectContaining({
          signalStatus: expect.objectContaining({
            status: "failed",
            reason: "signal repository unavailable",
          }),
          reliabilityGate: expect.objectContaining({
            status: "constrained",
            appliedRules: expect.arrayContaining([
              expect.objectContaining({
                key: "decision_signal_load_failure_blocks_execution",
                severity: "blocking",
              }),
            ]),
          }),
        }),
      }),
    );
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

  test("decideContext persists failed escalate run when searchKnowledge throws", async () => {
    mockSearchKnowledge.mockRejectedValueOnce(new Error("Database connection error"));

    const input = {
      decisionPoint: "verify code implementation",
      retrievalHints: {
        technologies: ["typescript"],
      },
      metadata: {
        primaryEvidence: [
          {
            kind: "verification_result",
            title: "Failed verification",
            summary: "The verification command failed before retrieval.",
            strength: "observed",
          },
        ],
      },
    };

    const result = await decideContext(input);

    expect(result.decision).toBe("escalate");
    expect(result.coverageSummary.degraded).toBe(true);
    expect(mockInsertContextDecisionRun).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "escalate",
        status: "failed",
        confidenceTrace: expect.objectContaining({
          forcedRules: ["retrieval_or_decision_failure_escalate"],
          primaryEvidence: [
            expect.objectContaining({
              title: "Failed verification",
              strength: "observed",
            }),
          ],
        }),
        input: expect.objectContaining({
          metadata: {},
        }),
      }),
    );
  });

  test("decideContext persists failed escalate run when non-search decision processing throws", async () => {
    mockSearchKnowledge.mockImplementation(async (params: any) => {
      const q = params.query.toLowerCase();
      if (q.includes("safe to execute")) {
        return [createDummyKnowledge({ id: "kb-support", title: "Support rule" })];
      }
      return [];
    });
    mockEnsureRuntimeSettingsLoaded.mockRejectedValueOnce(new Error("settings load failed"));

    const input = {
      decisionPoint: "verify code implementation",
      retrievalHints: {
        technologies: ["typescript"],
      },
    };

    const result = await decideContext(input);

    expect(result.decision).toBe("escalate");
    expect(result.coverageSummary.degraded).toBe(true);
    expect(mockInsertContextDecisionRun).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "escalate",
        status: "failed",
        confidenceTrace: expect.objectContaining({
          forcedRules: ["retrieval_or_decision_failure_escalate"],
          signalStatus: expect.objectContaining({
            status: "failed",
            reason: "settings load failed",
          }),
        }),
      }),
    );
  });

  test("marks the existing decision run failed when evidence persistence fails after run creation", async () => {
    mockSearchKnowledge.mockImplementation(async (params: any) => {
      const q = params.query.toLowerCase();
      if (q.includes("safe to execute")) {
        return [createDummyKnowledge({ id: "kb-support", title: "Support rule" })];
      }
      return [];
    });
    mockResolveAgenticCompileRouting.mockReturnValueOnce({
      enabled: false,
      provider: "mock-llm",
      timeoutMs: 5000,
      fallback: "local-llm",
      azureDeploymentSlots: [],
    });
    mockInsertContextDecisionEvidenceRows.mockRejectedValueOnce(
      new Error("evidence insert failed"),
    );

    const result = await decideContext({
      decisionPoint: "verify code implementation",
      retrievalHints: {
        technologies: ["typescript"],
      },
      metadata: {},
    });

    expect(result.decisionId).toBe("decision-run-id-123");
    expect(result.decision).toBe("escalate");
    expect(result.coverageSummary.degraded).toBe(true);
    expect(mockInsertContextDecisionRun).toHaveBeenCalledTimes(1);
    expect(mockMarkContextDecisionRunFailed).toHaveBeenCalledWith("decision-run-id-123", {
      reason: "evidence insert failed",
      stage: "context_decision_evidence",
      mandate:
        "Escalate because context_decision could not persist complete audit evidence for the decision.",
      agentMessage: expect.stringContaining("evidence insert failed"),
    });
  });

  test("does not create a duplicate failed run when marking the existing run failed also fails", async () => {
    mockSearchKnowledge.mockImplementation(async (params: any) => {
      const q = params.query.toLowerCase();
      if (q.includes("safe to execute")) {
        return [createDummyKnowledge({ id: "kb-support", title: "Support rule" })];
      }
      return [];
    });
    mockResolveAgenticCompileRouting.mockReturnValueOnce({
      enabled: false,
      provider: "mock-llm",
      timeoutMs: 5000,
      fallback: "local-llm",
      azureDeploymentSlots: [],
    });
    mockInsertContextDecisionEvidenceRows.mockRejectedValueOnce(
      new Error("evidence insert failed"),
    );
    mockMarkContextDecisionRunFailed.mockRejectedValueOnce(new Error("mark failed"));

    const result = await decideContext({
      decisionPoint: "verify code implementation",
      retrievalHints: {
        technologies: ["typescript"],
      },
      metadata: {},
    });

    expect(result.decisionId).toBe("decision-run-id-123");
    expect(result.decision).toBe("escalate");
    expect(result.agentMessage).toContain("evidence insert failed");
    expect(mockInsertContextDecisionRun).toHaveBeenCalledTimes(1);
    expect(mockMarkContextDecisionRunFailed).toHaveBeenCalledTimes(1);
  });

  test("stores primary evidence in confidence trace and caps claimed-only confidence", async () => {
    mockSearchKnowledge.mockImplementation(async (params: any) => {
      const q = params.query.toLowerCase();
      if (q.includes("safe to execute")) {
        return [
          createDummyKnowledge({
            id: "kb-support",
            title: "Implementation evidence support",
            body: "Proceed with the implementation when direct verification evidence is present.",
            score: 0.95,
            applicabilityScore: 80,
          }),
        ];
      }
      return [];
    });
    mockResolveAgenticCompileRouting.mockReturnValueOnce({
      enabled: false,
      provider: "mock-llm",
      timeoutMs: 5000,
      fallback: "local-llm",
      azureDeploymentSlots: [],
    });

    await decideContext({
      decisionPoint: "continue implementation with claimed verification evidence",
      retrievalHints: {
        technologies: ["typescript"],
        changeTypes: ["implementation"],
        domains: ["decision"],
      },
      metadata: {
        primaryEvidence: [
          {
            kind: "verification_result",
            title: "Claimed verification",
            summary: "User says tests passed, but no command output is attached.",
            strength: "claimed",
          },
        ],
      },
    });

    expect(mockInsertContextDecisionRun).toHaveBeenCalledWith(
      expect.objectContaining({
        confidence: expect.any(Number),
        confidenceTrace: expect.objectContaining({
          primaryEvidence: [
            expect.objectContaining({
              kind: "verification_result",
              strength: "claimed",
            }),
          ],
          confidenceCaps: expect.arrayContaining([
            expect.objectContaining({
              key: "primary_evidence_claimed_or_inferred",
              cap: 55,
            }),
          ]),
        }),
      }),
    );
    const runParams = mockInsertContextDecisionRun.mock.calls[0]?.[0];
    expect(runParams.confidence).toBeLessThanOrEqual(55);
    expect(runParams.input.metadata.primaryEvidence).toBeUndefined();
  });

  test("keeps EpisodeCard precedents separate from Knowledge evidence and applies failure cap", async () => {
    mockSearchEpisodes.mockResolvedValueOnce([createDummyEpisode()]);
    mockSearchKnowledge.mockImplementation(async (params: any) => {
      const q = params.query.toLowerCase();
      if (q.includes("safe to execute")) {
        return [
          createDummyKnowledge({
            id: "kb-support",
            title: "Implementation support",
            body: "Proceed with the implementation when verification evidence is present.",
            score: 0.95,
            applicabilityScore: 80,
          }),
        ];
      }
      return [];
    });
    mockResolveAgenticCompileRouting.mockReturnValueOnce({
      enabled: false,
      provider: "mock-llm",
      timeoutMs: 5000,
      fallback: "local-llm",
      azureDeploymentSlots: [],
    });

    await decideContext({
      decisionPoint: "continue implementation after similar verification failure",
      retrievalHints: {
        technologies: ["typescript"],
        changeTypes: ["implementation"],
        domains: ["decision"],
      },
      metadata: {
        primaryEvidence: [
          {
            kind: "verification_result",
            title: "Observed test run",
            summary: "A local verification command was observed.",
            strength: "observed",
          },
        ],
      },
    });

    const runParams = mockInsertContextDecisionRun.mock.calls[0]?.[0];
    expect(runParams.confidenceTrace.episodePrecedents).toEqual([
      expect.objectContaining({
        episodeId: "episode-1",
        usedFor: "risk_cap",
        importance: 80,
        confidence: 90,
      }),
    ]);
    expect(mockRecordEpisodeUsage).toHaveBeenCalledWith({
      usageKind: "decision",
      episodeIds: ["episode-1"],
    });
    expect(runParams.confidenceTrace.confidenceCaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "failure_episode_precedent", cap: 65 }),
      ]),
    );
    const persistedEvidence = mockInsertContextDecisionEvidenceRows.mock.calls[0]?.[1] as Array<{
      knowledgeId: string | null;
    }>;
    expect(persistedEvidence.some((item) => item.knowledgeId === "episode-1")).toBe(false);
  });

  test("prompts the LLM to evaluate support, counter, and Episode hits before continuing", async () => {
    mockSearchEpisodes.mockResolvedValueOnce([createDummyEpisode()]);
    const supportKnowledge = createDummyKnowledge({
      id: "kb-support",
      title: "Bounded continuation support",
      body: "Continue TypeScript implementation when rollback is available and verification can be run after the change.",
      score: 0.96,
      applicabilityScore: 100,
    });
    const unrelatedSupport = createDummyKnowledge({
      id: "kb-unrelated",
      title: "Dashboard editor cache rule",
      body: "Cache regex editor state for dashboard previews.",
      score: 0.25,
      applicabilityScore: 0,
    });
    const counterKnowledge = createDummyKnowledge({
      id: "kb-counter",
      title: "Irreversible restart counter",
      body: "A similar TypeScript implementation should stop only when restart impact is irreversible and rollback safeguards are absent.",
      polarity: "positive",
      score: 0.94,
      applicabilityScore: 80,
    });
    mockSearchKnowledge.mockImplementation(async (params: any) => {
      const q = params.query.toLowerCase();
      if (q.includes("safe to execute")) return [supportKnowledge, unrelatedSupport];
      if (q.includes("counterexample") || q.includes("failure condition")) {
        return [counterKnowledge];
      }
      return [];
    });

    const chat = vi
      .fn()
      .mockResolvedValueOnce({
        content: JSON.stringify({
          decision: "revise_and_execute",
          confidence: 78,
          mandate: "Continue with bounded safeguards.",
          selectedAction: "continue after verification",
          rejectedActions: [],
          reasoningSummary:
            "Knowledge Assessment override: risk is bounded by rollback and verification safeguards.",
          evidenceInterpretation: [
            {
              title: "Bounded continuation support",
              classification: "execution_support",
              adoption: "adopted",
              similarityToDecision: "same TypeScript implementation and verification context",
              appliesToProposedAction: true,
              effectOnDecision: "supports execute",
            },
            {
              title: "Dashboard editor cache rule",
              classification: "unrelated",
              adoption: "not_adopted",
              similarityToDecision: "different UI cache situation",
              appliesToProposedAction: false,
              effectOnDecision: "ignored",
            },
          ],
          episodeInterpretation: [
            {
              title: "Migration failure precedent",
              adoption: "adopted",
              similarityToDecision: "similar verification failure risk",
              effectOnDecision: "requires revision",
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        content:
          "判断は revise_and_execute です。support Knowledge は検証可能な TypeScript 実装という点で採用し、counter Knowledge は不可逆影響がない限り停止ではなく safeguards に使います。過去ケースは検証不足リスクが似ているため、先に検証条件を置けば継続できます。",
      });
    mockGetAgenticLlmProviders.mockResolvedValue([{ isConfigured: () => true, chat }]);

    await decideContext({
      decisionPoint: "continue TypeScript implementation with rollback verification safeguards",
      retrievalHints: {
        technologies: ["typescript"],
        changeTypes: ["implementation"],
        domains: ["decision"],
      },
      metadata: {
        primaryEvidence: [
          {
            kind: "verification_result",
            title: "Observed verification plan",
            summary: "A rollback and verification path is available.",
            strength: "observed",
          },
        ],
      },
    });

    const judgmentSystemPrompt = chat.mock.calls[0]?.[0]?.messages?.[0]?.content as string;
    const judgmentUserPrompt = chat.mock.calls[0]?.[0]?.messages?.[1]?.content as string;
    const answerSystemPrompt = chat.mock.calls[1]?.[0]?.messages?.[0]?.content as string;
    const answerUserPrompt = chat.mock.calls[1]?.[0]?.messages?.[1]?.content as string;
    expect(judgmentSystemPrompt).toContain(
      "Read each support, counter, risk, and EpisodeCard hit as a candidate that can be adopted or not adopted.",
    );
    expect(judgmentSystemPrompt).toContain(
      "Default toward execute or revise_and_execute when risk can be bounded with safeguards",
    );
    expect(judgmentUserPrompt).toContain("episodeInterpretation");
    expect(answerSystemPrompt).toContain("Do not write a mechanical coverage summary");
    expect(answerSystemPrompt).toContain("Prefer continuing autonomously when risk is bounded");
    expect(answerUserPrompt).toContain(
      "Support/preference Knowledge hits to evaluate for adoption:",
    );
    expect(answerUserPrompt).toContain("adoption=adopted; title=Bounded continuation support");
    expect(answerUserPrompt).toContain("adoption=not_adopted; title=Dashboard editor cache rule");
    expect(answerUserPrompt).toContain("Counter/risk Knowledge hits to evaluate for adoption:");
    expect(answerUserPrompt).toContain("Irreversible restart counter");
    expect(answerUserPrompt).toContain("Similar EpisodeCard precedents:");
    expect(answerUserPrompt).toContain("Migration failure precedent");
    expect(answerUserPrompt).toContain(
      "Include a risk estimate when counter/risk Knowledge or failure EpisodeCards are present",
    );
  });

  test("filters low relevance support into ranking trace instead of selected support", async () => {
    const unrelatedKnowledge = createDummyKnowledge({
      id: "kb-unrelated",
      title: "Dashboard editor cache rule",
      body: "Cache regex editor state for dashboard previews.",
      score: 0.25,
      applicabilityScore: 0,
    });
    mockSearchKnowledge.mockImplementation(async (params: any) => {
      const q = params.query.toLowerCase();
      if (q.includes("safe to execute")) return [unrelatedKnowledge];
      return [];
    });
    mockResolveAgenticCompileRouting.mockReturnValueOnce({
      enabled: false,
      provider: "mock-llm",
      timeoutMs: 5000,
      fallback: "local-llm",
      azureDeploymentSlots: [],
    });

    await decideContext({
      decisionPoint: "fix docs link failure from git status deletion",
      retrievalHints: {
        technologies: ["markdown"],
        changeTypes: ["docs"],
        domains: ["documentation"],
      },
      metadata: {},
    });

    const persistedEvidence = mockInsertContextDecisionEvidenceRows.mock.calls[0]?.[1] ?? [];
    expect(persistedEvidence).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          knowledgeId: "kb-unrelated",
          role: "selected_support",
        }),
      ]),
    );
    expect(mockInsertContextDecisionRun).toHaveBeenCalledWith(
      expect.objectContaining({
        confidenceTrace: expect.objectContaining({
          candidateTraces: expect.arrayContaining([
            expect.objectContaining({
              knowledgeId: "kb-unrelated",
              selectionStage: "relevance_filtered",
              selected: false,
            }),
          ]),
        }),
      }),
    );
  });
});
