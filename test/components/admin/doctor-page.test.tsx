import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
/** @vitest-environment jsdom */
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DoctorPage } from "../../../web/src/modules/admin/components/doctor.page";

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual("@tanstack/react-query");
  return {
    ...actual,
    useQuery: vi.fn(),
  };
});

const queryClient = new QueryClient();

const baseReport = {
  status: "degraded",
  checkedAt: "2026-05-21T13:26:44.509Z",
  summary: {
    blocking: 2,
    degraded: 2,
    maintenance: 1,
    skipped: 0,
  },
  reasons: [
    "KNOWLEDGE_ZERO_USE_HIGH",
    "VIBE_DISTILLATION_NEVER_RAN",
    "VIBE_DISTILLATION_PIPELINE_LOCK_STALE",
    "SOURCE_DISTILLATION_PIPELINE_LOCK_STALE",
    "ANTIGRAVITY_LOGS_SYNC_STALE",
  ],
  skippedChecks: [],
  db: { reachable: true, durationMs: 26 },
  vector: { installed: true },
  embedding: {
    configured: true,
    provider: "daemon",
    daemon: { url: "http://127.0.0.1:44512", reachable: true },
    cli: {
      python: "/tmp/.venv/bin/python",
      root: "/tmp/root",
      modelDir: "/tmp/model",
      usable: true,
    },
  },
  agenticLlm: {
    providerSetting: "azure-openai",
    selectedProvider: "azure-openai",
    fallbackOrder: ["azure-openai"],
    provider: "azure-openai",
    configured: true,
    reachable: true,
    model: "gpt-5-4-mini",
    endpoint: "https://example.openai.azure.com",
  },
  tables: {
    expected: ["knowledge_items", "sources"],
    existing: ["knowledge_items", "sources"],
    missing: [],
  },
  runs: {
    windowSize: 20,
    totalRuns: 20,
    degradedRuns: 15,
    degradedRate: 0.75,
    blockingRuns: 4,
    blockingRate: 0.2,
    usableRuns: 16,
    usableRate: 0.8,
    warningOnlyRuns: 15,
    warningOnlyRate: 0.75,
    noContentRuns: 3,
    noContentRate: 0.15,
    durationMsP50: 1982,
    durationMsP95: 6871.1,
    durationMsAvg: 3094.9,
    lastRunAt: "2026-05-21T13:25:54.789Z",
    lastRunAgeMinutes: 1,
    freshnessThresholdMinutes: 720,
    degradedRateThreshold: 0.5,
  },
  hitl: {
    draftCount: 39,
    oldestDraftAt: "2026-05-20T23:17:04.355Z",
    oldestDraftAgeMinutes: 850,
    backlogThresholdCount: 50,
    backlogThresholdAgeMinutes: 4320,
  },
  knowledgeLifecycle: {
    activeCount: 671,
    zeroUseActiveCount: 658,
    staleByDecayCount: 0,
    staleProcedureCount: 0,
    dynamicScoreAvg: 0.4,
    dynamicScoreP95: 0,
    lastCompiledAt: "2026-05-20T17:26:48.523Z",
    lastCompiledAgeMinutes: 1200,
    thresholds: {
      staleDecayFactor: 0.5,
      zeroUseWarningMinActiveCount: 10,
    },
  },
  mcp: {
    exposedTools: ["doctor"],
    requiredPrimaryTools: ["doctor"],
    missingPrimaryTools: [],
    staleKnowledgeCount: 0,
    staleSourceCount: 40,
    nextActions: ["stale source を再importまたは更新する（count: 40）"],
  },
  agentLogSync: {
    codex: {
      sessionDir: "/Users/y.noguchi/.codex/sessions",
      sessionDirExists: true,
      archivedSessionDir: "/Users/y.noguchi/.codex/archived_sessions",
      archivedSessionDirExists: true,
    },
    antigravity: {
      logDir: "/Users/y.noguchi/.gemini/antigravity/brain",
      configured: true,
      exists: true,
    },
    states: [
      {
        id: "codex_logs",
        lastSyncedAt: "2026-05-21T08:31:04.936Z",
        lastSyncedAgeMinutes: 295,
        cursorFiles: 385,
        skipped: false,
        warnings: [],
      },
      {
        id: "antigravity_logs",
        lastSyncedAt: "2026-05-19T09:44:11.413Z",
        lastSyncedAgeMinutes: 3102,
        cursorFiles: 121,
        skipped: false,
        warnings: [],
      },
    ],
    launchAgent: {
      label: "com.memory-router.agent-log-sync",
      plistPath: "/Users/y.noguchi/Library/LaunchAgents/com.memory-router.agent-log-sync.plist",
      installed: true,
      loaded: true,
      state: "not running",
    },
    nextActions: [],
  },
  vibeDistillation: {
    launchAgent: {
      label: "com.memory-router.distill-pipeline",
      plistPath: "/Users/y.noguchi/Library/LaunchAgents/com.memory-router.distill-pipeline.plist",
      installed: true,
      loaded: true,
      state: "running",
    },
    runs: {
      totalRuns: 0,
      okRuns: 0,
      skippedRuns: 0,
      outcomeKindCounts: [],
      skippedRunReasons: [],
      failedRuns: 0,
      lastRunAt: null,
      lastRunAgeMinutes: null,
      lastOkRunAt: null,
      lastOkRunAgeMinutes: null,
    },
    jobs: {
      queued: 1150,
      running: 0,
      paused: 0,
      failed: 0,
      lastPausedAt: null,
      lastError: null,
    },
    queueHealth: {
      queued: 1150,
      running: 0,
      retryablePaused: 0,
      staleRunning: 0,
      blockedByHigherPriority: true,
      oldestQueuedAt: "2026-05-21T07:49:40.165Z",
      oldestQueuedAgeMinutes: 337,
      oldestRunningAt: null,
      oldestRunningAgeMinutes: null,
      lock: {
        path: "/tmp/vibe.lock",
        exists: true,
        pid: 123,
        createdAt: "2026-05-21T13:04:36.225Z",
        ageSeconds: 1328,
        staleByCreatedAge: true,
      },
    },
    nextActions: ["vibe lock を確認する"],
  },
  sourceDistillation: {
    launchAgent: {
      label: "com.memory-router.distill-pipeline",
      plistPath: "/Users/y.noguchi/Library/LaunchAgents/com.memory-router.distill-pipeline.plist",
      installed: true,
      loaded: true,
      state: "running",
    },
    runs: {
      totalRuns: 5,
      okRuns: 5,
      skippedRuns: 0,
      outcomeKindCounts: [{ reason: "knowledge_created", count: 5 }],
      skippedRunReasons: [],
      failedRuns: 0,
      lastRunAt: "2026-05-21T02:48:15.457Z",
      lastRunAgeMinutes: 638,
      lastOkRunAt: "2026-05-21T02:48:15.457Z",
      lastOkRunAgeMinutes: 638,
    },
    jobs: {
      queued: 36,
      running: 1,
      paused: 0,
      failed: 0,
      lastPausedAt: null,
      lastError: null,
    },
    queueHealth: {
      queued: 36,
      running: 1,
      retryablePaused: 0,
      staleRunning: 0,
      blockedByHigherPriority: false,
      oldestQueuedAt: "2026-05-21T07:49:40.146Z",
      oldestQueuedAgeMinutes: 337,
      oldestRunningAt: "2026-05-21T13:26:00.057Z",
      oldestRunningAgeMinutes: 1,
      lock: {
        path: "/tmp/source.lock",
        exists: true,
        pid: 456,
        createdAt: "2026-05-21T13:04:36.225Z",
        ageSeconds: 1328,
        staleByCreatedAge: true,
      },
    },
    nextActions: ["source queue を確認する"],
  },
};

describe("DoctorPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders dashboard sections and human-readable reason labels", () => {
    vi.mocked(useQuery).mockReturnValue({
      data: baseReport,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
    } as any);

    render(
      <QueryClientProvider client={queryClient}>
        <DoctorPage />
      </QueryClientProvider>,
    );

    expect(screen.getByText("Doctor")).toBeInTheDocument();
    expect(screen.getAllByText("degraded").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("System Status")).toBeInTheDocument();
    expect(screen.getByText("Compile Usable")).toBeInTheDocument();
    expect(screen.getByText("Runtime Matrix")).toBeInTheDocument();
    expect(screen.getByText("Automation Matrix")).toBeInTheDocument();
    expect(screen.getByText("Compile Quality Mix")).toBeInTheDocument();
    expect(screen.getByText("Distillation Queue")).toBeInTheDocument();
    expect(screen.getByText("Doctor Signals")).toBeInTheDocument();
    expect(screen.getByText("Next Actions")).toBeInTheDocument();

    expect(screen.getByText("未使用の active knowledge が多い")).toBeInTheDocument();
    expect(screen.getByText("会話ログ蒸留が未実行")).toBeInTheDocument();
    expect(screen.getByText("KNOWLEDGE_ZERO_USE_HIGH")).toBeInTheDocument();
    expect(
      screen.getByText("stale source を再importまたは更新する（count: 40）"),
    ).toBeInTheDocument();
    expect(screen.getByText("vibe lock を確認する")).toBeInTheDocument();
    expect(screen.getByText("source queue を確認する")).toBeInTheDocument();
  }, 15_000);

  it("renders fallback text for unknown reason codes", () => {
    const report = {
      ...baseReport,
      reasons: ["UNMAPPED_CUSTOM_REASON"],
      mcp: { ...baseReport.mcp, nextActions: [] },
      vibeDistillation: { ...baseReport.vibeDistillation, nextActions: [] },
      sourceDistillation: { ...baseReport.sourceDistillation, nextActions: [] },
    };

    vi.mocked(useQuery).mockReturnValue({
      data: report,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
    } as any);

    render(
      <QueryClientProvider client={queryClient}>
        <DoctorPage />
      </QueryClientProvider>,
    );

    expect(screen.getByText("Unmapped Custom Reason")).toBeInTheDocument();
    expect(screen.getByText("Doctor が未定義の診断コードを返しました。")).toBeInTheDocument();
    expect(screen.getByText("No pending actions")).toBeInTheDocument();
  });

  it("renders error card when doctor query fails", () => {
    vi.mocked(useQuery).mockReturnValue({
      data: undefined,
      isError: true,
      isFetching: false,
      refetch: vi.fn(),
    } as any);

    render(
      <QueryClientProvider client={queryClient}>
        <DoctorPage />
      </QueryClientProvider>,
    );

    expect(screen.getByText("Doctor API Error")).toBeInTheDocument();
  });
});
