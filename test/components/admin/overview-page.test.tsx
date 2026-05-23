import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
/** @vitest-environment jsdom */
import { render, screen, fireEvent, act } from "@testing-library/react";
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
    distillationQueue: [
      { pending: 1, running: 2, completed: 5, failed: 0 }
    ],
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
};

const queryMockState = vi.hoisted(() => ({
  overviewError: null as Error | null,
  overviewData: null as any,
  doctorData: null as any,
  overviewRefetch: vi.fn(),
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
      return {
        data: queryMockState.overviewData,
        error: queryMockState.overviewError,
        isError: Boolean(queryMockState.overviewError),
        isFetching: false,
        isLoading: false,
        refetch: queryMockState.overviewRefetch,
      };
    }),
  };
});

const queryClient = new QueryClient();

describe("OverviewPage", () => {
  beforeEach(() => {
    queryClient.clear();
    queryMockState.overviewError = null;
    queryMockState.overviewData = JSON.parse(JSON.stringify(defaultOverviewData));
    queryMockState.doctorData = JSON.parse(JSON.stringify(defaultDoctorData));
    queryMockState.overviewRefetch.mockClear();
    queryMockState.doctorRefetch.mockClear();
  });

  it("renders correctly", () => {
    render(
      <QueryClientProvider client={queryClient}>
        <OverviewPage />
      </QueryClientProvider>,
    );
    expect(screen.getByText(/overview/i)).toBeInTheDocument();
    expect(screen.getByText("Compile Usable")).toBeInTheDocument();
    expect(screen.getByText("Compile runs:")).toBeInTheDocument();
    expect(screen.getByText("Usable:")).toBeInTheDocument();
    expect(screen.getByText("Warning:")).toBeInTheDocument();
    expect(screen.getByText("Blocking:")).toBeInTheDocument();
    expect(screen.getByText("No Content:")).toBeInTheDocument();
    expect(screen.getByText("Local LLM 30d")).toBeInTheDocument();
    expect(screen.getByText("Cloud LLM Cost 30d")).toBeInTheDocument();
    expect(screen.getByText(/gpt-5-4-mini/)).toBeInTheDocument();
    expect(screen.getByText("Daily LLM Tokens & Cloud Cost (14d)")).toBeInTheDocument();
    expect(screen.getByText("Compile Quality Mix")).toBeInTheDocument();
    expect(screen.getByText("Compile Latency")).toBeInTheDocument();
    expect(screen.getByText("Knowledge Usage Lifecycle")).toBeInTheDocument();
    expect(screen.getByText("Knowledge Source & Community Coverage")).toBeInTheDocument();
    expect(
      screen.getByText("unlinked 4 / communities 1/3 covered, thin 1, no-source 1"),
    ).toBeInTheDocument();
    expect(screen.getByText(/Brave Search/)).toBeInTheDocument();
    expect(screen.queryByText("Doctor Signals")).not.toBeInTheDocument();
  });

  it("keeps existing overview content visible when the overview query reports an error", () => {
    queryMockState.overviewError = new Error("/api/overview failed: 500");

    render(
      <QueryClientProvider client={queryClient}>
        <OverviewPage />
      </QueryClientProvider>,
    );

    expect(screen.getByText("Overview API Error")).toBeInTheDocument();
    expect(screen.getByText("/api/overview failed: 500")).toBeInTheDocument();
    expect(screen.getByText("Knowledge Assets")).toBeInTheDocument();
    expect(screen.getByText("Daily LLM Tokens & Cloud Cost (14d)")).toBeInTheDocument();
    expect(screen.queryByText("Doctor Signals")).not.toBeInTheDocument();
  });

  it("calls overview.refetch and doctor.refetch when refresh button is clicked", () => {
    render(
      <QueryClientProvider client={queryClient}>
        <OverviewPage />
      </QueryClientProvider>,
    );

    const refreshButton = screen.getByRole("button", { name: /refresh/i });
    expect(refreshButton).toBeInTheDocument();

    fireEvent.click(refreshButton);

    expect(queryMockState.overviewRefetch).toHaveBeenCalled();
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

  it("displays 'All items successfully linked' when unlinkedKnowledge is 0", () => {
    queryMockState.overviewData.kpis.unlinkedKnowledge = 0;
    queryMockState.overviewData.kpis.linkedKnowledge = 10;
    queryMockState.overviewData.kpis.knowledgeTotal = 10;

    render(
      <QueryClientProvider client={queryClient}>
        <OverviewPage />
      </QueryClientProvider>,
    );

    expect(screen.getByText("All items successfully linked")).toBeInTheDocument();
  });

  it("displays 'No active LLM sources' when bySource list is empty", () => {
    queryMockState.overviewData.llmUsage.bySource = [];

    render(
      <QueryClientProvider client={queryClient}>
        <OverviewPage />
      </QueryClientProvider>,
    );

    expect(screen.getByText("No active LLM sources")).toBeInTheDocument();
  });

  it("calculates compile Usable rate from KPIs when doctorReport is null", () => {
    // doctorReport is completely null
    queryMockState.doctorData = null;

    queryMockState.overviewData.kpis.compileRuns = 10;
    queryMockState.overviewData.kpis.compileOkRuns = 9;
    queryMockState.overviewData.kpis.compileDegradedRuns = 1;
    queryMockState.overviewData.kpis.compileFailedRuns = 0;

    render(
      <QueryClientProvider client={queryClient}>
        <OverviewPage />
      </QueryClientProvider>,
    );

    // Ok: 9 / Total: 10 -> Usable Rate: 90.0%
    expect(screen.getAllByText("90.0%").length).toBeGreaterThan(0);
  });
});
