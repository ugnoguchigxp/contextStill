/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { ContextDecisionPage } from "../../../web/src/modules/context-decision/components/context-decision.page";
import {
  useContextDecisionDetail,
  useContextDecisionFeedbackMutation,
  useContextDecisionRuns,
  useCreateContextDecisionMutation,
} from "../../../web/src/modules/context-decision/hooks/context-decision.hooks";

// hooks のモック
vi.mock("../../../web/src/modules/context-decision/hooks/context-decision.hooks", () => ({
  useCreateContextDecisionMutation: vi.fn(),
  useContextDecisionDetail: vi.fn(),
  useContextDecisionFeedbackMutation: vi.fn(),
  useContextDecisionRuns: vi.fn(),
}));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
    },
  },
});

const mockRuns = [
  {
    id: "run-1",
    sessionId: "sess-1",
    decisionPoint: "Should we build?",
    decision: "execute",
    selectedAction: "build",
    mandate: "Do build",
    confidence: 90,
    status: "completed",
    humanFeedback: null,
    createdAt: "2026-06-10T12:00:00.000Z",
    updatedAt: "2026-06-10T12:00:00.000Z",
  },
  {
    id: "run-2",
    sessionId: "sess-1",
    decisionPoint: "Should we release?",
    decision: "escalate",
    selectedAction: null,
    mandate: "Escalate to admin",
    confidence: 50,
    status: "failed",
    humanFeedback: "good",
    createdAt: "2026-06-10T12:10:00.000Z",
    updatedAt: "2026-06-10T12:10:00.000Z",
  },
];

const mockDetail = {
  run: {
    ...mockRuns[0],
    rejectedActions: [],
    retrievalHints: {
      technologies: ["typescript"],
      changeTypes: ["feat"],
      domains: ["core"],
    },
    agentMessage: "Yes, you should build.",
    confidenceTrace: {
      supportScore: 90,
      counterScore: 10,
      preferenceScore: 80,
      coverageScore: 85,
      verificationScore: 70,
      historicalFeedbackScore: 50,
      signalStatus: {
        status: "complete",
        evidenceCount: 3,
        compileSignalCount: 2,
        communitySignalCount: 1,
        landscapeSignalCount: 1,
        reason: "signals loaded",
      },
      compileSignals: {
        "kb-1": {
          usedCount: 2,
          wrongCount: 0,
          offTopicCount: 0,
        },
      },
      communitySignals: {
        "kb-counter": {
          communityLabel: "Decision Review",
        },
      },
      landscapeSignals: {
        "kb-counter": {
          classification: "over_selected_not_used",
        },
      },
      knowledgePrior: {
        status: "available",
        source: "retrieval_prior_v1",
        referenceOnly: true,
        notUsedForScoring: true,
        evidenceCount: 3,
        candidateCount: 5,
        summary: "Prior summary",
        signals: ["ok"],
        cautions: ["careful"],
      },
      knowledgeAssessment: {
        status: "evaluable",
        recommendedDirection: "execute",
        knowledgeCoverage: 80,
        supportStrength: 90,
        counterEvidenceStrength: 10,
        riskStrength: 5,
        preferenceAlignment: 90,
        applicabilityScore: 85,
        consensusScore: 95,
        conflictScore: 5,
        sourceQualityScore: 80,
        outOfDistributionScore: 10,
        retrievalMethods: ["vector"],
        reason: "Looks good",
        meaningfulMetrics: [],
      },
      outcomePredictor: {
        status: "ready",
        model: "ml-random-forest",
        modelVersion: "1.0",
        featureVersion: "context-decision-ml-features-v1",
        predictedDecision: "execute",
        confidence: 0.85,
        trainingSampleCount: 10,
        classDistribution: { execute: 8, reject: 2 },
        features: {
          supportHitCount: 3,
          selectedSupportCount: 2,
          deterministicConfidence: 90,
          relatedBadSignalCount: 0,
        },
        reason: "Matches previous executions",
      },
      reliabilityGate: {
        status: "constrained",
        originalDecision: "execute",
        finalDecision: "revise_and_execute",
        confidenceCap: 68,
        appliedRules: [
          {
            key: "weak_coverage_requires_revision",
            severity: "warning",
            message: "Knowledge coverage is weak.",
          },
        ],
        riskEvidence: {
          count: 1,
          forcedDisplay: true,
          titles: ["Check risk before build"],
        },
        badFeedback: {
          count: 1,
          strongCount: 1,
          averageConfidence: 80,
          maxConfidence: 80,
        },
        evidenceCoverage: {
          assessmentStatus: "weak_coverage",
          supportEvidenceCount: 1,
          riskEvidenceCount: 1,
          knowledgeCoverage: 48,
        },
      },
    },
    guardrails: { riskEvidenceCount: 1 },
    unsupportedAlternatives: [],
    metadata: {},
  },
  evidence: [
    {
      id: "ev-1",
      decisionRunId: "run-1",
      knowledgeId: "kb-1",
      role: "selected_support",
      weightAtDecision: 90,
      summary: "Rule: Always build on green",
      sourceRefs: ["green.md"],
      metadata: {
        status: "active",
        type: "rule",
        signals: {
          compile: {
            usedCount: 2,
            wrongCount: 0,
            offTopicCount: 0,
          },
        },
      },
      createdAt: "2026-06-10T12:00:00.000Z",
    },
    {
      id: "ev-2",
      decisionRunId: "run-1",
      knowledgeId: "kb-risk",
      role: "risk_warning",
      weightAtDecision: 88,
      summary: "Check risk before build: Run verification before build.",
      sourceRefs: ["risk.md"],
      metadata: { status: "active", type: "rule" },
      createdAt: "2026-06-10T12:00:00.000Z",
    },
    {
      id: "ev-3",
      decisionRunId: "run-1",
      knowledgeId: "kb-counter",
      role: "counter_evidence",
      weightAtDecision: 77,
      summary: "Counter build case: Similar builds needed scope revision.",
      sourceRefs: ["counter.md"],
      metadata: {
        status: "active",
        type: "rule",
        signals: {
          community: {
            communityLabel: "Decision Review",
            health: { thinEvidence: true },
          },
          landscape: {
            classification: "over_selected_not_used",
          },
        },
      },
      createdAt: "2026-06-10T12:00:00.000Z",
    },
  ],
  coverage: [
    {
      id: "cov-1",
      query: "always build",
      queryRole: "support",
      hitCount: 1,
      maxSimilarity: 0.95,
      selectedKnowledgeIds: ["kb-1"],
      rejectedKnowledgeIds: [],
      reason: "Matched query",
      createdAt: "2026-06-10T12:00:00.000Z",
    },
  ],
  feedback: [],
  effects: [
    {
      id: "effect-1",
      knowledgeId: "kb-1",
      effect: "penalize",
      amount: -6,
      reason: "Human Bad feedback for decision-driving evidence.",
      confidence: 80,
      status: "applied",
      createdAt: "2026-06-10T12:00:00.000Z",
    },
  ],
};

describe("ContextDecisionPage", () => {
  const mockMutateAsync = vi.fn();
  const mockMutate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(useContextDecisionRuns).mockReturnValue({
      data: mockRuns,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    } as any);

    vi.mocked(useContextDecisionDetail).mockReturnValue({
      data: mockDetail,
      isLoading: false,
      error: null,
    } as any);

    vi.mocked(useCreateContextDecisionMutation).mockReturnValue({
      mutateAsync: mockMutateAsync,
      isPending: false,
      error: null,
    } as any);

    vi.mocked(useContextDecisionFeedbackMutation).mockReturnValue({
      mutate: mockMutate,
      isPending: false,
    } as any);
  });

  test("renders request page by default and populates example form", () => {
    render(
      <QueryClientProvider client={queryClient}>
        <ContextDecisionPage />
      </QueryClientProvider>,
    );

    // 見出しの確認
    expect(screen.getByText("Context Decision Control Plane")).toBeInTheDocument();
    expect(screen.getByText("Decision Request")).toBeInTheDocument();
    expect(screen.queryByTitle("Decision confidence")).not.toBeInTheDocument();

    // フォームにサンプルを挿入
    const exampleButton = screen.getByText("Example");
    fireEvent.click(exampleButton);

    const decisionPointTextarea = screen.getByLabelText("Decision Point") as HTMLTextAreaElement;
    expect(decisionPointTextarea.value).toContain("Should I continue implementing the UI form");

    const techInput = screen.getByLabelText("Technologies") as HTMLInputElement;
    expect(techInput.value).toBe("typescript, react");
  });

  test("validates and submits a new decision request", async () => {
    mockMutateAsync.mockResolvedValue({ decisionId: "run-1" });

    render(
      <QueryClientProvider client={queryClient}>
        <ContextDecisionPage />
      </QueryClientProvider>,
    );

    const askButton = screen.getByText("Ask Decision");
    fireEvent.click(askButton);

    // 必須チェックエラーの確認
    expect(screen.getByText("Decision point is required.", { exact: false })).toBeInTheDocument();

    // フォームを入力して送信
    const exampleButton = screen.getByText("Example");
    fireEvent.click(exampleButton);
    fireEvent.click(askButton);

    expect(mockMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        decisionPoint: expect.stringContaining("Should I continue implementing"),
      }),
    );
  });

  test("renders decision details correctly when selected", async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <ContextDecisionPage />
      </QueryClientProvider>,
    );

    // サイドバーのランをクリックして詳細モードに移行
    const sidebarItem = screen.getAllByText("Should we build?")[0];
    fireEvent.click(sidebarItem);

    // 詳細パネルが表示されていることの確認
    await waitFor(() => {
      expect(screen.getByText("Yes, you should build.")).toBeInTheDocument();
    });
    expect(screen.getByText("Do build")).toBeInTheDocument();
    expect(screen.getByText("Always build on green")).toBeInTheDocument();
    expect(screen.getByText("Decision Rationale")).toBeInTheDocument();
    expect(screen.getByText("Knowledge Evidence")).toBeInTheDocument();
    expect(screen.getByText("Used as support")).toBeInTheDocument();
    expect(screen.getByText("Used as risk")).toBeInTheDocument();
    expect(screen.getByText("Counter evidence")).toBeInTheDocument();
    expect(screen.getByText("Knowledge Prior")).toBeInTheDocument();
    expect(screen.getByText("Outcome Predictor")).toBeInTheDocument();
    expect(screen.getByText("Knowledge Assessment")).toBeInTheDocument();
    expect(screen.getByText("Decision Signals")).toBeInTheDocument();
    expect(screen.getByText("signals loaded")).toBeInTheDocument();
    expect(screen.getByText("Reliability Gate")).toBeInTheDocument();
    expect(screen.getByText("weak_coverage_requires_revision")).toBeInTheDocument();
    expect(screen.getAllByText("Check risk before build").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Counter build case").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Compile history").length).toBeGreaterThan(0);
    expect(screen.getByText("Used 2")).toBeInTheDocument();
    expect(screen.getByText("Not used 0")).toBeInTheDocument();
    expect(screen.getByText("compile used 2")).toBeInTheDocument();
    expect(screen.getByText("landscape over_selected_not_used")).toBeInTheDocument();
    expect(screen.getByText("community Decision Review")).toBeInTheDocument();
    expect(screen.getByText("thin evidence")).toBeInTheDocument();
    expect(screen.getByText("Feedback Effects")).toBeInTheDocument();
    expect(screen.getByText("Bad feedback penalty")).toBeInTheDocument();
    expect(screen.getByText("-6")).toBeInTheDocument();

    // フィードバックの送信
    const goodButton = screen.getByText("Good");
    fireEvent.click(goodButton);

    expect(mockMutate).toHaveBeenCalledWith({
      decisionId: "run-1",
      value: "good",
    });
  });

  test("handles loading state in details", async () => {
    // 詳細がロード中の状態
    vi.mocked(useContextDecisionDetail).mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    } as any);

    render(
      <QueryClientProvider client={queryClient}>
        <ContextDecisionPage />
      </QueryClientProvider>,
    );

    const sidebarItem = screen.getAllByText("Should we build?")[0];
    fireEvent.click(sidebarItem);

    await waitFor(() => {
      expect(screen.getByText("Loading detail...")).toBeInTheDocument();
    });
  });

  test("handles error state in details", async () => {
    // エラー状態
    vi.mocked(useContextDecisionDetail).mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("Failed to fetch detail"),
    } as any);

    render(
      <QueryClientProvider client={queryClient}>
        <ContextDecisionPage />
      </QueryClientProvider>,
    );

    // Sidebar から選択して詳細を表示
    const sidebarItem = screen.getAllByText("Should we build?")[0];
    fireEvent.click(sidebarItem);

    await waitFor(() => {
      expect(screen.getByText("Error: Failed to fetch detail")).toBeInTheDocument();
    });
  });
});
