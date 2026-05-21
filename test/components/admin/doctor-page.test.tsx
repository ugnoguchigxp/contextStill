/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import React from "react";
import { DoctorPage } from "../../../web/src/modules/admin/components/doctor.page";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual("@tanstack/react-query");
  return {
    ...actual,
    useQuery: vi.fn(),
  };
});

const queryClient = new QueryClient();

// テスト用モックデータ (ほぼ全ロジックを網羅する巨大なレポート)
const mockDoctorReport = {
  status: "warning",
  db: { reachable: true, durationMs: 45 },
  vector: { installed: true },
  runs: { degradedRate: 0.15, durationMsP50: 120, durationMsP95: 500, durationMsAvg: 230 },
  embedding: {
    provider: "openai",
    daemon: { reachable: true },
    cli: { usable: true, modelDir: "/models/embedding" },
  },
  agentLogSync: {
    codex: { sessionDirExists: true, sessions: 12 },
    antigravity: { configured: true, exists: true },
    launchAgent: { loaded: true, installed: true },
    states: [{ name: "sync-1" }],
  },
  reasons: ["Database latency is high", "Degraded performance observed"],
  issues: ["Some issue description"],
  hitl: { draftCount: 5, oldestDraftAgeMinutes: 75 },
  vibeDistillation: {
    launchAgent: { loaded: true, installed: true },
    runs: {
      totalRuns: 100,
      okRuns: 80,
      skippedRuns: 15,
      failedRuns: 5,
      lastRunAgeMinutes: 45, // 1時間未満のテスト（45 min）
      lastOkRunAgeMinutes: 120, // 48時間未満のテスト（2.0 h）
      skippedRunReasons: [{ reason: "test_reason", count: 3 }],
      outcomeKindCounts: [
        { reason: "candidate_rejected", count: 10 },
        { reason: "batch_paused_circuit_breaker", count: 2 },
        { reason: "invalid_candidate", count: 3 },
        { reason: "job_already_running", count: 4 },
        { reason: "knowledge_created", count: 50 },
        { reason: "knowledge_deduped", count: 15 },
        { reason: "llm_empty_response", count: 1 },
        { reason: "llm_provider_error", count: 1 },
        { reason: "llm_timeout", count: 1 },
        { reason: "llm_unparseable", count: 1 },
        { reason: "missing_external_evidence", count: 1 },
        { reason: "missing_verification_tool_evidence", count: 1 },
        { reason: "mixed_candidate_rejections", count: 1 },
        { reason: "no_candidate", count: 1 },
        { reason: "processing_error", count: 1 },
        { reason: "promotion_paused_backpressure", count: 1 },
        { reason: "verification_no_candidate", count: 1 },
        { reason: "unknown_custom_reason", count: 1 }, // デフォルトフォールバックのテスト
      ],
    },
    queueHealth: {
      retryablePaused: 2,
      staleRunning: 1,
      oldestQueuedAgeMinutes: 3000, // 48時間以上のテスト (2.1 d)
      lock: { staleByCreatedAge: false, exists: true },
    },
    jobs: { queued: 5, running: 2, paused: 1, failed: 0 },
  },
  sourceDistillation: {
    launchAgent: { loaded: false, installed: true }, // loaded: false, installed: true のテスト (installed)
    runs: {
      totalRuns: 50,
      okRuns: 40,
      skippedRuns: 10,
      failedRuns: 0,
      lastRunAgeMinutes: null, // nullのテスト
      lastOkRunAgeMinutes: undefined, // undefinedのテスト
      skippedRunReasons: [],
      outcomeKindCounts: [],
    },
    queueHealth: {
      retryablePaused: 0,
      staleRunning: 0,
      oldestQueuedAgeMinutes: null,
      lock: { staleByCreatedAge: true, exists: true }, // staleByCreatedAge のテスト (stale)
    },
    jobs: { queued: 0, running: 0, paused: 0, failed: 0 },
  },
};

describe("DoctorPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders doctor page with full report properly", () => {
    vi.mocked(useQuery).mockReturnValue({
      data: mockDoctorReport,
      isLoading: false,
      error: null,
    } as any);

    render(
      <QueryClientProvider client={queryClient}>
        <DoctorPage />
      </QueryClientProvider>,
    );

    // 1. 基本ヘッダーとステータスの確認
    expect(screen.getByText("Doctor")).toBeInTheDocument();
    expect(screen.getByText("warning")).toBeInTheDocument();

    // 2. Runtime パネルのデータ確認
    expect(screen.getByText("Database")).toBeInTheDocument();
    expect(screen.getAllByText("reachable").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("45ms")).toBeInTheDocument();
    expect(screen.getByText("pgvector")).toBeInTheDocument();
    expect(screen.getAllByText("installed").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("0.15")).toBeInTheDocument(); // degraded rate
    expect(screen.getByText("120ms")).toBeInTheDocument(); // compile latency p50
    expect(screen.getByText("500ms")).toBeInTheDocument(); // compile latency p95
    expect(screen.getByText("230ms")).toBeInTheDocument(); // compile latency avg

    // 3. Embedding パネルのデータ確認
    expect(screen.getByText("openai")).toBeInTheDocument();
    expect(screen.queryByText("offline")).not.toBeInTheDocument();
    expect(screen.getByText("/models/embedding")).toBeInTheDocument();

    // 4. Agent Log Sync の確認
    expect(screen.getByText("Codex sessions")).toBeInTheDocument();
    expect(screen.getByText("Antigravity logs")).toBeInTheDocument();
    expect(screen.getAllByText("loaded").length).toBeGreaterThanOrEqual(1);

    // 5. Reasons のリスト表示確認
    expect(screen.getByText("Database latency is high")).toBeInTheDocument();
    expect(screen.getByText("Degraded performance observed")).toBeInTheDocument();

    // 6. HITL Backlog の確認
    expect(screen.getByText("Draft count")).toBeInTheDocument();
    expect(screen.getAllByText("5").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("75 min")).toBeInTheDocument();

    // 7. Vibe Distillation の動作確認 (年齢フォーマットや outcome 種別)
    expect(screen.getByText("Vibe Distillation")).toBeInTheDocument();
    expect(screen.getByText("100")).toBeInTheDocument(); // total runs
    expect(screen.getByText("80")).toBeInTheDocument(); // ok runs
    expect(screen.getAllByText("15").length).toBeGreaterThanOrEqual(1); // skipped runs
    expect(screen.getAllByText("5").length).toBeGreaterThanOrEqual(1); // failed runs

    // Age のフォーマットテスト結果の確認
    expect(screen.getByText("45 min")).toBeInTheDocument(); // lastRunAgeMinutes (45)
    expect(screen.getByText("2.0 h")).toBeInTheDocument(); // lastOkRunAgeMinutes (120)
    expect(screen.getByText("2.1 d")).toBeInTheDocument(); // oldestQueuedAgeMinutes (3000)

    // Legacy skip の確認
    expect(screen.getByText("test_reason: 3")).toBeInTheDocument();

    // Pipeline lockの表示
    expect(screen.getByText("held")).toBeInTheDocument(); // exists is true, staleByCreatedAge is false

    // Outcome 理由の網羅テスト (Labels, Focus, Counts)
    // 17種類以上の outcome をアサート
    expect(screen.getByText("Rejected")).toBeInTheDocument();
    expect(screen.getByText("candidate value")).toBeInTheDocument();
    expect(screen.getByText("Circuit paused")).toBeInTheDocument();
    expect(screen.getByText("Invalid candidate")).toBeInTheDocument();
    expect(screen.getByText("Already running")).toBeInTheDocument();
    expect(screen.getByText("Created")).toBeInTheDocument();
    expect(screen.getByText("review draft")).toBeInTheDocument();
    expect(screen.getByText("Deduped")).toBeInTheDocument();
    expect(screen.getByText("Empty response")).toBeInTheDocument();
    expect(screen.getByText("LLM provider")).toBeInTheDocument();
    expect(screen.getByText("LLM timeout")).toBeInTheDocument();
    expect(screen.getByText("Unparseable")).toBeInTheDocument();
    expect(screen.getByText("Evidence missing")).toBeInTheDocument();
    expect(screen.getByText("Tool evidence missing")).toBeInTheDocument();
    expect(screen.getByText("Mixed rejection")).toBeInTheDocument();
    expect(screen.getByText("No candidate")).toBeInTheDocument();
    expect(screen.getByText("Processing error")).toBeInTheDocument();
    expect(screen.getByText("Backpressure")).toBeInTheDocument();
    expect(screen.getByText("Verification empty")).toBeInTheDocument();
    expect(screen.getAllByText("unknown_custom_reason").length).toBeGreaterThanOrEqual(1); // フォールバックの確認
  });

  it("renders alternative statuses (not installed launchAgent, lock stale, lock clear, outcomes empty, reasons empty)", () => {
    const alternativeReport = {
      ...mockDoctorReport,
      status: "failed", // failed status test
      reasons: [], // empty reasons test
      vibeDistillation: {
        ...mockDoctorReport.vibeDistillation,
        launchAgent: { loaded: false, installed: false }, // launchAgent "not installed"
        runs: {
          ...mockDoctorReport.vibeDistillation.runs,
          lastRunAgeMinutes: null,
          lastOkRunAgeMinutes: null,
          skippedRunReasons: [],
        },
        queueHealth: {
          ...mockDoctorReport.vibeDistillation.queueHealth,
          oldestQueuedAgeMinutes: null,
          lock: { staleByCreatedAge: false, exists: false }, // lock is clear
        },
      },
      sourceDistillation: {
        ...mockDoctorReport.sourceDistillation,
        queueHealth: {
          ...mockDoctorReport.sourceDistillation.queueHealth,
          lock: { staleByCreatedAge: true, exists: true }, // lock is stale
        },
      },
    };

    vi.mocked(useQuery).mockReturnValue({
      data: alternativeReport,
      isLoading: false,
      error: null,
    } as any);

    render(
      <QueryClientProvider client={queryClient}>
        <DoctorPage />
      </QueryClientProvider>,
    );

    // failed ステータスの確認
    expect(screen.getByText("failed")).toBeInTheDocument();

    // reasons が空の時の代替テキスト確認
    expect(screen.getByText("degraded reasonはありません。")).toBeInTheDocument();

    // Vibe Distillation の launchAgent が not installed バッジであること
    expect(screen.getAllByText("not installed").length).toBeGreaterThanOrEqual(1);

    // Pipeline lockの表示 (stale & clear)
    expect(screen.getByText("clear")).toBeInTheDocument(); // vibeDistillation lock exists: false
    expect(screen.getByText("stale")).toBeInTheDocument(); // sourceDistillation lock staleByCreatedAge: true

    // Source Distillation は outcomes が空なので、空テキストが表示されること
    expect(screen.getByText("No outcome data")).toBeInTheDocument();
  });
});
