import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
/** @vitest-environment jsdom */
import { act, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OverviewPage } from "../../../web/src/modules/admin/components/overview.page";

const defaultDoctorData = {
  status: "degraded",
  checkedAt: "2026-05-20T00:00:00.000Z",
  db: { reachable: true },
  storage: { writable: true },
  llm: { available: true },
  vector: { installed: true },
  mcp: {
    nextActions: ["unused active knowledge を確認する（103/112）"],
    staleKnowledgeCount: 1,
  },
  reasons: ["KNOWLEDGE_ZERO_USE_HIGH", "DEGRADED_RATE_HIGH"],
  runs: {
    totalRuns: 10,
    usableRuns: 8,
    usableRate: 0.8,
    warningOnlyRuns: 2,
    warningOnlyRate: 0.2,
    blockingRuns: 1,
    blockingRate: 0.1,
    noContentRuns: 1,
    noContentRate: 0.1,
    durationMsAvg: 2400,
    durationSamples: [
      {
        runId: "550e8400-e29b-41d4-a716-446655440021",
        label: "#1",
        durationMs: 900,
        status: "ok",
        createdAt: "2026-05-20T00:00:00.000Z",
      },
      {
        runId: "550e8400-e29b-41d4-a716-446655440022",
        label: "#2",
        durationMs: 2400,
        status: "degraded",
        createdAt: "2026-05-20T00:01:00.000Z",
      },
    ],
  },
  knowledgeLifecycle: {
    activeCount: 8,
    zeroUseActiveCount: 3,
    staleByDecayCount: 1,
  },
};

const defaultOverviewData = {
  checkedAt: "2026-05-20T00:00:00.000Z",
  kpis: {
    knowledgeTotal: 10,
    activeKnowledge: 8,
    draftKnowledge: 2,
    deprecatedKnowledge: 0,
    rules: 7,
    procedures: 3,
    embeddedKnowledge: 9,
    zeroUseActiveKnowledge: 0,
    wikiPages: 5,
    indexedSources: 5,
    sourceFragments: 20,
    sourceLinks: 8,
    linkedKnowledge: 6,
    unlinkedKnowledge: 4,
    sourceEvidenceLinkedKnowledge: 6,
    sourceEvidenceUnlinkedKnowledge: 4,
    originLinkedKnowledge: 3,
    originUnlinkedKnowledge: 7,
    provenanceTraceableKnowledge: 8,
    provenanceUntraceableKnowledge: 2,
    originLinksByKind: {
      vibe_memory: 2,
      agent_candidate: 1,
      landscape_review_item: 0,
    },
    sourceCommunities: 3,
    sourceCoveredCommunities: 1,
    sourceThinCommunities: 1,
    sourceMissingCommunities: 1,
    vibeRecords: 12,
    vibeSessions: 3,
    vibeRecordsWithDiffs: 9,
    agentDiffEntries: 30,
    compileRuns: 0,
    compileOkRuns: 0,
    compileDegradedRuns: 0,
    compileFailedRuns: 0,
  },
  charts: {
    knowledgeByStatusType: [],
    dynamicScoreBuckets: [],
    compileRunsByDay: [],
    vibeRecordsByDay: [],
    sourceCoverage: [],
    communitySourceCoverage: [
      { label: "covered", count: 1 },
      { label: "thin", count: 1 },
      { label: "no-source", count: 1 },
    ],
  },
  llmUsage: {
    kpis: {
      totalCalls30d: 24,
      measuredCalls30d: 18,
      estimatedCalls30d: 6,
      localTokensTotal30d: 1000,
      localPromptTokens30d: 400,
      localCompletionTokens30d: 600,
      cloudTokensTotal30d: 2000,
      cloudPromptTokens30d: 900,
      cloudCompletionTokens30d: 1100,
      measuredTokensTotal30d: 2200,
      estimatedTokensTotal30d: 800,
      measuredCoveragePercent30d: 75,
      reasoningTokensTotal30d: 100,
      cloudCostJpyTotal30d: 3.5,
      cloudModel: "gpt-5-4-mini",
      cloudInputCostJpyPerMTokens: 165,
      cloudOutputCostJpyPerMTokens: 660,
    },
    daily: [
      {
        day: "2026-05-20",
        localPromptTokens: 100,
        localCompletionTokens: 200,
        localReasoningTokens: 0,
        cloudPromptTokens: 300,
        cloudCompletionTokens: 400,
        cloudReasoningTokens: 50,
        totalTokens: 1000,
        measuredTokens: 700,
        estimatedTokens: 300,
        measuredCalls: 3,
        estimatedCalls: 1,
        costJpy: 1.25,
      },
    ],
    bySource: [
      {
        source: "context-compiler",
        calls: 10,
        measuredCalls: 8,
        estimatedCalls: 2,
        promptTokens: 700,
        completionTokens: 500,
        totalTokens: 1200,
      },
    ],
  },
  searchApiStatus: {
    brave: {
      status: "ok",
      cooldownUntil: null,
      lastError: null,
    },
    exa: {
      status: "cooldown",
      cooldownUntil: "2026-05-20T00:10:00.000Z",
      lastError: "Exa search HTTP 429",
    },
  },
  compileEvalStats: {
    windowLabel: "All time",
    evaluatedRunCount: 2,
    evaluationCount: 3,
    averageAvg: 84.3,
    metrics: [
      { metric: "relevance", label: "Relevance", average: 90 },
      { metric: "actionability", label: "Actionability", average: 82 },
      { metric: "coverage", label: "Coverage", average: 78 },
      { metric: "clarity", label: "Clarity", average: 88 },
      { metric: "specificity", label: "Specificity", average: 83.5 },
    ],
  },
  productValueStats: {
    windowLabel: "All time",
    metrics: [
      {
        metric: "compile_adoption_rate",
        label: "Compile adoption",
        rate: 0.667,
        count: 2,
        denominator: 3,
        evidenceLabel: "useful/partial compile_eval outcomes",
      },
      {
        metric: "compile_reuse_rate",
        label: "Compile reuse",
        rate: 0.8,
        count: 8,
        denominator: 10,
        evidenceLabel: "compile runs with pack items or selected traces",
      },
      {
        metric: "decision_success_rate",
        label: "Decision success",
        rate: 0.833,
        count: 5,
        denominator: 6,
        evidenceLabel: "human good plus system success feedback",
      },
      {
        metric: "bad_feedback_rate",
        label: "Bad feedback",
        rate: 0.167,
        count: 1,
        denominator: 6,
        evidenceLabel: "human bad plus failed/regression/override/discard feedback",
      },
      {
        metric: "prevented_rework_signals",
        label: "Rework avoided",
        rate: null,
        count: 3,
        denominator: 10,
        evidenceLabel: "revise/rollback/discard/reject decisions plus applied feedback effects",
      },
    ],
    evidence: {
      compileRunCount: 10,
      evaluatedCompileRunCount: 2,
      compileEvaluationCount: 3,
      acceptedCompileEvaluationCount: 2,
      reusedCompileRunCount: 8,
      decisionRunCount: 10,
      decisionFeedbackCount: 7,
      knownDecisionFeedbackCount: 6,
      successfulDecisionFeedbackCount: 5,
      badDecisionFeedbackCount: 1,
      preventedReworkSignalCount: 3,
      appliedFeedbackEffectCount: 1,
    },
  },
  landscape: {
    status: "ok",
    windowDays: 30,
    generatedAt: "2026-05-20T00:00:00.000Z",
    snapshot: {
      totalCommunities: 12,
      strongAttractorCount: 2,
      usefulAttractorCount: 4,
      negativeCandidateCount: 0,
      overSelectedNotUsedCount: 1,
      deadZoneReachabilityCount: 3,
      deadZoneStaleCount: 0,
      feedbackInsufficientCount: 4,
      topRiskCount: 4,
    },
    replay: {
      comparedRunCount: 20,
      averageOverlapRate: 0.92,
      retainedItemCount: 86,
      missingFromCurrentItemCount: 3,
      newlyRetrievedItemCount: 154,
      usedBaselineLostItemCount: 2,
      highChurnRunCount: 18,
      currentNoMatchRunCount: 0,
      promotionGateMode: "review_required",
    },
  },
};

const queryMockState = vi.hoisted(() => ({
  domainErrors: {} as Record<string, Error | null>,
  domainData: {} as Record<string, any>,
  doctorData: null as any,
  knowledgeRefetch: vi.fn(),
  landscapeRefetch: vi.fn(),
  systemRefetch: vi.fn(),
  llmRefetch: vi.fn(),
  doctorRefetch: vi.fn(),
}));

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual("@tanstack/react-query");
  return {
    ...actual,
    useQuery: vi.fn().mockImplementation((options) => {
      if (options.queryKey?.includes("doctor")) {
        return {
          data: queryMockState.doctorData,
          error: null,
          isError: false,
          isFetching: false,
          isLoading: false,
          refetch: queryMockState.doctorRefetch,
        };
      }
      if (options.queryKey?.[0] === "overview-domain") {
        const domain = String(options.queryKey[1]);
        const refetchByDomain: Record<string, ReturnType<typeof vi.fn>> = {
          "knowledge-assets": queryMockState.knowledgeRefetch,
          "landscape-health": queryMockState.landscapeRefetch,
          "system-quality": queryMockState.systemRefetch,
          "llm-resources": queryMockState.llmRefetch,
        };
        const error = queryMockState.domainErrors[domain] ?? null;
        return {
          data: queryMockState.domainData[domain] ?? null,
          error,
          isError: Boolean(error),
          isFetching: false,
          isLoading: queryMockState.domainData[domain] === null,
          refetch: refetchByDomain[domain] ?? vi.fn(),
        };
      }
      return {
        data: null,
        error: null,
        isError: false,
        isFetching: false,
        isLoading: false,
        refetch: vi.fn(),
      };
    }),
  };
});

const queryClient = new QueryClient();

describe("OverviewPage", () => {
  beforeEach(() => {
    queryClient.clear();
    queryMockState.domainErrors = {
      "knowledge-assets": null,
      "landscape-health": null,
      "system-quality": null,
      "llm-resources": null,
    };
    queryMockState.domainData = {
      "knowledge-assets": {
        checkedAt: defaultOverviewData.checkedAt,
        kpis: JSON.parse(JSON.stringify(defaultOverviewData.kpis)),
        charts: JSON.parse(JSON.stringify(defaultOverviewData.charts)),
      },
      "landscape-health": {
        checkedAt: defaultOverviewData.checkedAt,
        landscape: JSON.parse(JSON.stringify(defaultOverviewData.landscape)),
      },
      "system-quality": {
        checkedAt: defaultOverviewData.checkedAt,
        kpis: JSON.parse(JSON.stringify(defaultOverviewData.kpis)),
        compileRunHealth: JSON.parse(JSON.stringify(defaultDoctorData.runs)),
        compileEvalStats: JSON.parse(JSON.stringify(defaultOverviewData.compileEvalStats)),
        productValueStats: JSON.parse(JSON.stringify(defaultOverviewData.productValueStats)),
        charts: JSON.parse(JSON.stringify(defaultOverviewData.charts)),
        searchApiStatus: JSON.parse(JSON.stringify(defaultOverviewData.searchApiStatus)),
      },
      "llm-resources": {
        checkedAt: defaultOverviewData.checkedAt,
        llmUsage: JSON.parse(JSON.stringify(defaultOverviewData.llmUsage)),
      },
    };
    queryMockState.doctorData = JSON.parse(JSON.stringify(defaultDoctorData));
    queryMockState.knowledgeRefetch.mockClear();
    queryMockState.landscapeRefetch.mockClear();
    queryMockState.systemRefetch.mockClear();
    queryMockState.llmRefetch.mockClear();
    queryMockState.doctorRefetch.mockClear();
  });

  it("renders correctly", () => {
    render(
      <QueryClientProvider client={queryClient}>
        <OverviewPage />
      </QueryClientProvider>,
    );
    expect(screen.getByText(/overview/i)).toBeInTheDocument();
    expect(screen.getByText("Compile Avg Score")).toBeInTheDocument();
    expect(screen.getByText("Feedback Count")).toBeInTheDocument();
    expect(screen.getByText("Evaluated Runs")).toBeInTheDocument();
    expect(screen.getAllByText("84.3").length).toBeGreaterThan(0);
    expect(screen.getByText("Product Value Evidence")).toBeInTheDocument();
    expect(screen.getByText("Compile adoption")).toBeInTheDocument();
    expect(screen.getByText("Compile reuse")).toBeInTheDocument();
    expect(screen.getByText("Decision success")).toBeInTheDocument();
    expect(screen.getByText("Bad feedback")).toBeInTheDocument();
    expect(screen.getByText("Rework avoided")).toBeInTheDocument();
    expect(screen.getByText("66.7%")).toBeInTheDocument();
    expect(screen.getByText("3 / 10")).toBeInTheDocument();
    expect(screen.getByText("Eval Stats:")).toBeInTheDocument();
    expect(screen.getByText("Window:")).toBeInTheDocument();
    expect(screen.getAllByText("All time").length).toBeGreaterThan(0);
    expect(screen.getByText("Compile:")).toBeInTheDocument();
    expect(screen.getByText("Ok:")).toBeInTheDocument();
    expect(screen.getByText("Degraded:")).toBeInTheDocument();
    expect(screen.getAllByText("Failed:").length).toBeGreaterThan(0);
    expect(screen.getByText("Local LLM 30d")).toBeInTheDocument();
    expect(screen.getByText("Cloud LLM Cost 30d")).toBeInTheDocument();
    expect(screen.getByText(/gpt-5-4-mini/)).toBeInTheDocument();
    expect(screen.getByText("Daily LLM Tokens & Cloud Cost (14d)")).toBeInTheDocument();
    expect(screen.getByText("Compile Eval Metrics (All time, n=3)")).toBeInTheDocument();
    expect(screen.getByText("Compile Latency")).toBeInTheDocument();
    expect(screen.getByText("Knowledge Usage Lifecycle")).toBeInTheDocument();
    expect(screen.getByText("Knowledge Source & Community Coverage")).toBeInTheDocument();
    expect(screen.getByText("Knowledge Landscape Health")).toBeInTheDocument();
    expect(screen.getByText("Attractors")).toBeInTheDocument();
    expect(screen.getByText("Dead zones")).toBeInTheDocument();
    expect(screen.getByText("Replay overlap")).toBeInTheDocument();
    expect(screen.getByText("Gate: review required")).toBeInTheDocument();
    expect(screen.getByText("Field Health Mix")).toBeInTheDocument();
    expect(screen.getByText("Replay Stability")).toBeInTheDocument();
    expect(
      screen.getByText("unlinked 4 / communities 1/3 covered, thin 1, no-source 1"),
    ).toBeInTheDocument();
    expect(screen.getByText(/Brave Search/)).toBeInTheDocument();
    expect(screen.queryByText("Doctor Signals")).not.toBeInTheDocument();
  }, 10_000);

  it("renders domain placeholders before domain payloads arrive", () => {
    queryMockState.domainData = {
      "knowledge-assets": null,
      "landscape-health": null,
      "system-quality": null,
      "llm-resources": null,
    };

    render(
      <QueryClientProvider client={queryClient}>
        <OverviewPage />
      </QueryClientProvider>,
    );

    expect(screen.getByText("Knowledge Assets")).toBeInTheDocument();
    expect(screen.getByText("Knowledge Landscape Health")).toBeInTheDocument();
    expect(screen.getByText("System Quality & Health")).toBeInTheDocument();
    expect(screen.getByText("LLM Resources & Cost")).toBeInTheDocument();
    expect(screen.getAllByText("Loading").length).toBeGreaterThanOrEqual(4);
  });

  it("keeps other domains visible when one domain query reports an error", () => {
    queryMockState.domainData["llm-resources"] = null;
    queryMockState.domainErrors["llm-resources"] = new Error(
      "/api/overview/domains/llm-resources failed: 500",
    );

    render(
      <QueryClientProvider client={queryClient}>
        <OverviewPage />
      </QueryClientProvider>,
    );

    expect(screen.getByText("/api/overview/domains/llm-resources failed: 500")).toBeInTheDocument();
    expect(screen.getByText("Knowledge Assets")).toBeInTheDocument();
    expect(screen.getByText("System Quality & Health")).toBeInTheDocument();
    expect(screen.queryByText("Doctor Signals")).not.toBeInTheDocument();
  });

  it("keeps overview usable when landscape summary is unavailable", () => {
    queryMockState.domainData["landscape-health"].landscape = {
      status: "unavailable",
      windowDays: 30,
      error: "landscape replay comparison failed",
    };

    render(
      <QueryClientProvider client={queryClient}>
        <OverviewPage />
      </QueryClientProvider>,
    );

    expect(screen.getByText("Knowledge Landscape Health")).toBeInTheDocument();
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    expect(
      screen.getByText("Landscape summary could not be loaded for this dashboard refresh."),
    ).toBeInTheDocument();
    expect(screen.getByText("Knowledge Assets")).toBeInTheDocument();
    expect(screen.getByText("System Quality & Health")).toBeInTheDocument();
  });

  it("calls domain refetches and doctor.refetch when refresh button is clicked", () => {
    render(
      <QueryClientProvider client={queryClient}>
        <OverviewPage />
      </QueryClientProvider>,
    );

    const refreshButton = screen.getByRole("button", { name: /refresh/i });
    expect(refreshButton).toBeInTheDocument();

    fireEvent.click(refreshButton);

    expect(queryMockState.knowledgeRefetch).toHaveBeenCalled();
    expect(queryMockState.landscapeRefetch).toHaveBeenCalled();
    expect(queryMockState.systemRefetch).toHaveBeenCalled();
    expect(queryMockState.llmRefetch).toHaveBeenCalled();
    expect(queryMockState.doctorRefetch).toHaveBeenCalled();
  });

  it("renders search API cooldown timer and updates it every second", () => {
    vi.useFakeTimers();
    const mockDate = new Date("2026-05-20T00:00:00.000Z");
    vi.setSystemTime(mockDate);

    render(
      <QueryClientProvider client={queryClient}>
        <OverviewPage />
      </QueryClientProvider>,
    );

    // Exa cooldown is "2026-05-20T00:10:00.000Z" -> 10 minutes (00:10:00)
    expect(screen.getByText("00:10:00")).toBeInTheDocument();

    // Advance 1 second
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(screen.getByText("00:09:59")).toBeInTheDocument();

    vi.useRealTimers();
  });

  it("displays 'All items have source evidence' when sourceEvidenceUnlinkedKnowledge is 0", () => {
    queryMockState.domainData["knowledge-assets"].kpis.sourceEvidenceUnlinkedKnowledge = 0;
    queryMockState.domainData["knowledge-assets"].kpis.sourceEvidenceLinkedKnowledge = 10;
    queryMockState.domainData["knowledge-assets"].kpis.knowledgeTotal = 10;

    render(
      <QueryClientProvider client={queryClient}>
        <OverviewPage />
      </QueryClientProvider>,
    );

    expect(screen.getByText("All items have source evidence")).toBeInTheDocument();
  });

  it("displays 'No active LLM sources' when bySource list is empty", () => {
    queryMockState.domainData["llm-resources"].llmUsage.bySource = [];

    render(
      <QueryClientProvider client={queryClient}>
        <OverviewPage />
      </QueryClientProvider>,
    );

    expect(screen.getByText("No active LLM sources")).toBeInTheDocument();
  });

  it("uses system-quality compile eval stats instead of legacy doctor usable rate", () => {
    queryMockState.domainData["system-quality"].kpis.compileRuns = 10;
    queryMockState.domainData["system-quality"].kpis.compileOkRuns = 9;
    queryMockState.domainData["system-quality"].kpis.compileDegradedRuns = 1;
    queryMockState.domainData["system-quality"].kpis.compileFailedRuns = 0;
    queryMockState.domainData["system-quality"].compileRunHealth = {
      ...JSON.parse(JSON.stringify(defaultDoctorData.runs)),
      totalRuns: 10,
      degradedRuns: 1,
      degradedRate: 0.1,
      usableRuns: 9,
      usableRate: 0.9,
      warningOnlyRuns: 1,
      warningOnlyRate: 0.1,
      blockingRuns: 0,
      blockingRate: 0,
      noContentRuns: 0,
      noContentRate: 0,
    };
    queryMockState.domainData["system-quality"].compileEvalStats = {
      ...JSON.parse(JSON.stringify(defaultOverviewData.compileEvalStats)),
      averageAvg: 91.5,
    };
    queryMockState.doctorData = {
      ...JSON.parse(JSON.stringify(defaultDoctorData)),
      runs: {
        ...JSON.parse(JSON.stringify(defaultDoctorData.runs)),
        totalRuns: 10,
        usableRuns: 1,
        usableRate: 0.1,
      },
    };

    render(
      <QueryClientProvider client={queryClient}>
        <OverviewPage />
      </QueryClientProvider>,
    );

    expect(screen.getAllByText("91.5").length).toBeGreaterThan(0);
    expect(screen.queryByText("10.0%")).not.toBeInTheDocument();
  });
});
