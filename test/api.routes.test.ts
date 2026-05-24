import { Hono } from "hono";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import app from "../api/app.js";
import { adminApiKeyAuth } from "../api/middleware/admin-auth.js";
import { listAuditLogsForApi } from "../api/modules/audit/audit.repository.js";
import { auditLogsRouter } from "../api/modules/audit/audit.routes.js";
import { listCandidateItems } from "../api/modules/candidates/candidates.repository.js";
import { candidatesRouter } from "../api/modules/candidates/candidates.routes.js";
import { contextCompilerRouter } from "../api/modules/context-compiler/context-compiler.routes.js";
import {
  compilePackForApi,
  getRunDetailForApi,
  listRunsForApi,
  saveRunKnowledgeFeedbackForApi,
} from "../api/modules/context-compiler/context-compiler.service.js";
import { doctorRouter } from "../api/modules/doctor/doctor.routes.js";
import { getDoctorReportForApi } from "../api/modules/doctor/doctor.service.js";
import {
  bulkUpdateKnowledgeStatus,
  countKnowledgeItems,
  createKnowledgeItem,
  deleteKnowledgeItem,
  listKnowledgeItems,
  listKnowledgeTagDefinitionsForApi,
  recordKnowledgeFeedback,
  updateKnowledgeItem,
} from "../api/modules/knowledge/knowledge.repository.js";
import { knowledgeRouter } from "../api/modules/knowledge/knowledge.routes.js";
import { fetchOverviewDashboardForApi } from "../api/modules/overview/overview.repository.js";
import { overviewRouter } from "../api/modules/overview/overview.routes.js";
import { settingsRouter } from "../api/modules/settings/settings.routes.js";
import {
  getSettingsForApi,
  reloadRuntimeCacheForApi,
  testProviderForApi,
  updateSettingsForApi,
} from "../api/modules/settings/settings.service.js";
import { vibeMemoryRouter } from "../api/modules/vibe-memory/vibe-memory.routes.js";
import { groupedConfig } from "../src/config.js";
import { recordVibeMemoryWithDiffEntries } from "../src/modules/vibe-memory/vibe-memory.service.js";
import { compileRunDetailSchema } from "../src/shared/schemas/compile-run.schema.js";
import { type ContextPack, contextPackSchema } from "../src/shared/schemas/context-pack.schema.js";
import { type DoctorReport, doctorReportSchema } from "../src/shared/schemas/doctor.schema.js";
import {
  type OverviewDashboard,
  overviewDashboardSchema,
} from "../src/shared/schemas/overview.schema.js";

vi.mock("../api/modules/context-compiler/context-compiler.service.js", () => ({
  compilePackForApi: vi.fn(),
  getRunDetailForApi: vi.fn(),
  getRunDetailParamSchema: z.object({
    id: z.string().uuid(),
  }),
  runKnowledgeFeedbackParamSchema: z.object({
    id: z.string().uuid(),
  }),
  listRunsForApi: vi.fn(),
  listRunsQuerySchema: z.object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
  }),
  saveRunKnowledgeFeedbackForApi: vi.fn(),
}));

vi.mock("../api/modules/doctor/doctor.service.js", () => ({
  getDoctorReportForApi: vi.fn(),
}));

vi.mock("../api/modules/overview/overview.repository.js", () => ({
  fetchOverviewDashboardForApi: vi.fn(),
}));

vi.mock("../api/modules/settings/settings.service.js", () => ({
  getSettingsForApi: vi.fn(),
  updateSettingsForApi: vi.fn(),
  testProviderForApi: vi.fn(),
  reloadRuntimeCacheForApi: vi.fn(),
}));

vi.mock("../api/modules/candidates/candidates.repository.js", () => ({
  candidateListSortByValues: [
    "targetKey",
    "candidateTitle",
    "coverageStatus",
    "knowledgeStatus",
    "outcome",
    "qualityScore",
    "latestUpdatedAt",
  ] as const,
  candidateOutcomeValues: [
    "stored",
    "ready_not_finalized",
    "rejected",
    "retryable",
    "candidate_only",
    "target_pending",
  ] as const,
  listCandidateItems: vi.fn(),
}));

vi.mock("../api/modules/knowledge/knowledge.repository.js", () => ({
  bulkUpdateKnowledgeStatus: vi.fn(),
  countKnowledgeItems: vi.fn(),
  createKnowledgeItem: vi.fn(),
  deleteKnowledgeItem: vi.fn(),
  listKnowledgeTagDefinitionsForApi: vi.fn(),
  listKnowledgeItems: vi.fn(),
  recordKnowledgeFeedback: vi.fn(),
  updateKnowledgeItem: vi.fn(),
}));

vi.mock("../api/modules/audit/audit.repository.js", () => ({
  listAuditLogsForApi: vi.fn(),
}));

vi.mock("../src/modules/vibe-memory/vibe-memory.service.js", () => ({
  recordVibeMemoryWithDiffEntries: vi.fn(),
}));

const buildApp = () => {
  const app = new Hono();
  app.route("/api/audit-logs", auditLogsRouter);
  app.route("/api/candidates", candidatesRouter);
  app.route("/api/context", contextCompilerRouter);
  app.route("/api/doctor", doctorRouter);
  app.route("/api/knowledge", knowledgeRouter);
  app.route("/api/overview", overviewRouter);
  app.route("/api/settings", settingsRouter);
  app.route("/api/vibe-memory", vibeMemoryRouter);
  return app;
};

const validPack: ContextPack = {
  runId: "550e8400-e29b-41d4-a716-446655440000",
  goal: "api contract goal",
  retrievalMode: "task_context",
  status: "ok",
  minimalTasks: ["Inspect relevant knowledge and source material"],
  rules: [],
  procedures: [],
  warnings: [],
  sourceRefs: ["memory-router://packs/run/550e8400-e29b-41d4-a716-446655440000#full"],
  diagnostics: {
    degradedReasons: [],
    retrievalStats: {},
  },
};

const validCompileResponse = {
  pack: validPack,
  markdown: "No Content",
};

const validRunDetail = compileRunDetailSchema.parse({
  run: {
    id: validPack.runId,
    goal: validPack.goal,
    retrievalMode: validPack.retrievalMode,
    status: validPack.status,
    degradedReasons: validPack.diagnostics.degradedReasons,
    durationMs: 42,
    source: "ui",
    createdAt: "2026-05-15T00:00:00.000Z",
    tokenBudget: 5000,
    input: { goal: validPack.goal, changeTypes: ["feature"] },
  },
  pack: validPack,
  outputMarkdown: "No Content",
  selectedItems: [],
  knowledgeFeedback: [],
  snapshotAvailable: true,
});

const validRunKnowledgeFeedback = {
  savedCount: 2,
  updatedCount: 1,
  queueCreatedCount: 1,
  queueDismissedCount: 0,
  affectedKnowledgeIds: [
    "550e8400-e29b-41d4-a716-446655440001",
    "550e8400-e29b-41d4-a716-446655440002",
  ],
};

const validDistillationQueueHealth = {
  queued: 0,
  running: 0,
  retryablePaused: 0,
  staleRunning: 0,
  blockedByHigherPriority: false,
  oldestQueuedAt: null,
  oldestQueuedAgeMinutes: null,
  oldestRunningAt: null,
  oldestRunningAgeMinutes: null,
  lock: {
    path: "/tmp/distillation.lock",
    exists: false,
    pid: null,
    createdAt: null,
    ageSeconds: null,
    staleByCreatedAge: false,
  },
};

const validDoctorReport: DoctorReport = {
  status: "ok",
  checkedAt: "2026-05-15T00:00:00.000Z",
  summary: {
    blocking: 0,
    degraded: 0,
    maintenance: 0,
    skipped: 0,
  },
  reasons: [],
  reasonDetails: [],
  skippedChecks: [],
  db: { reachable: true, durationMs: 1 },
  vector: { installed: true },
  embedding: {
    configured: true,
    provider: "daemon",
    daemon: { url: "http://127.0.0.1:44512", reachable: true },
    cli: {
      python: "/usr/bin/python3",
      root: "/tmp/embedding",
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
    endpoint: "https://test.openai.azure.com",
  },
  tables: {
    expected: ["knowledge_items"],
    existing: ["knowledge_items"],
    missing: [],
  },
  runs: {
    windowSize: 10,
    totalRuns: 1,
    degradedRuns: 0,
    degradedRate: 0,
    durationMsP50: 80,
    durationMsP95: 120,
    durationMsAvg: 90,
    durationSamples: [
      {
        runId: "550e8400-e29b-41d4-a716-446655440002",
        label: "#1",
        durationMs: 90,
        status: "ok",
        createdAt: "2026-05-15T00:00:00.000Z",
      },
    ],
    lastRunAt: "2026-05-15T00:00:00.000Z",
    lastRunAgeMinutes: 1,
    freshnessThresholdMinutes: 720,
    degradedRateThreshold: 0.5,
  },
  hitl: {
    draftCount: 0,
    oldestDraftAt: null,
    oldestDraftAgeMinutes: null,
    backlogThresholdCount: 50,
    backlogThresholdAgeMinutes: 4320,
  },
  knowledgeLifecycle: {
    activeCount: 0,
    zeroUseActiveCount: 0,
    staleByDecayCount: 0,
    staleProcedureCount: 0,
    dynamicScoreAvg: null,
    dynamicScoreP95: null,
    lastCompiledAt: null,
    lastCompiledAgeMinutes: null,
    thresholds: {
      staleDecayFactor: 0.5,
      zeroUseWarningMinActiveCount: 10,
    },
  },
  mcp: {
    exposedTools: ["context_compile"],
    requiredPrimaryTools: ["context_compile"],
    missingPrimaryTools: [],
    staleKnowledgeCount: 0,
    staleSourceCount: 0,
    nextActions: [],
  },
  agentLogSync: {
    codex: {
      sessionDir: "/tmp/codex",
      sessionDirExists: true,
      archivedSessionDir: "/tmp/codex-archived",
      archivedSessionDirExists: true,
    },
    antigravity: {
      logDir: "/tmp/antigravity",
      configured: true,
      exists: true,
    },
    states: [],
    launchAgent: {
      label: "memory-router.agent-log-sync",
      plistPath: "/tmp/agent-log-sync.plist",
      installed: true,
      loaded: true,
      state: "loaded",
    },
    nextActions: [],
  },
  vibeDistillation: {
    launchAgent: {
      label: "memory-router.vibe-distillation",
      plistPath: "/tmp/vibe-distillation.plist",
      installed: true,
      loaded: true,
      state: "loaded",
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
      queued: 0,
      running: 0,
      paused: 0,
      failed: 0,
      lastPausedAt: null,
      lastError: null,
    },
    queueHealth: validDistillationQueueHealth,
    nextActions: [],
  },
  sourceDistillation: {
    launchAgent: {
      label: "memory-router.source-distillation",
      plistPath: "/tmp/source-distillation.plist",
      installed: true,
      loaded: true,
      state: "loaded",
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
      queued: 0,
      running: 0,
      paused: 0,
      failed: 0,
      lastPausedAt: null,
      lastError: null,
    },
    queueHealth: validDistillationQueueHealth,
    nextActions: [],
  },
};

const validOverviewDashboard: OverviewDashboard = overviewDashboardSchema.parse({
  checkedAt: "2026-05-20T00:00:00.000Z",
  kpis: {
    knowledgeTotal: 334,
    activeKnowledge: 300,
    draftKnowledge: 34,
    deprecatedKnowledge: 0,
    rules: 302,
    procedures: 32,
    embeddedKnowledge: 334,
    zeroUseActiveKnowledge: 293,
    wikiPages: 40,
    indexedSources: 40,
    sourceFragments: 1235,
    sourceLinks: 254,
    linkedKnowledge: 254,
    unlinkedKnowledge: 80,
    sourceCommunities: 40,
    sourceCoveredCommunities: 28,
    sourceThinCommunities: 7,
    sourceMissingCommunities: 5,
    vibeRecords: 1072,
    vibeSessions: 118,
    vibeRecordsWithDiffs: 963,
    agentDiffEntries: 10462,
    compileRuns: 52,
    compileOkRuns: 1,
    compileDegradedRuns: 51,
    compileFailedRuns: 0,
  },
  charts: {
    knowledgeByStatusType: [
      { status: "active", rule: 270, procedure: 30 },
      { status: "draft", rule: 32, procedure: 2 },
      { status: "deprecated", rule: 0, procedure: 0 },
    ],
    dynamicScoreBuckets: [
      { bucket: "0", count: 327 },
      { bucket: "0-1", count: 0 },
      { bucket: "1-5", count: 0 },
      { bucket: "5-10", count: 0 },
      { bucket: "10-15", count: 7 },
      { bucket: "15-20", count: 0 },
      { bucket: "20-25", count: 0 },
      { bucket: "25-30", count: 0 },
      { bucket: "30-35", count: 0 },
      { bucket: "35+", count: 0 },
    ],
    compileRunsByDay: [
      { day: "2026-05-19", ok: 0, degraded: 1, failed: 0, avgDurationMs: 1250 },
      { day: "2026-05-20", ok: 1, degraded: 0, failed: 0, avgDurationMs: 980 },
    ],
    vibeRecordsByDay: [
      { day: "2026-05-19", records: 12 },
      { day: "2026-05-20", records: 8 },
    ],
    sourceCoverage: [
      { label: "linked", count: 254 },
      { label: "unlinked", count: 80 },
    ],
    communitySourceCoverage: [
      { label: "covered", count: 28 },
      { label: "thin", count: 7 },
      { label: "no-source", count: 5 },
    ],
    distillationQueue: [
      { targetKind: "wiki_file", pending: 100, running: 1, paused: 0, completed: 20, failed: 0 },
      { targetKind: "vibe_memory", pending: 17, running: 0, paused: 0, completed: 2, failed: 0 },
    ],
  },
  llmUsage: {
    kpis: {
      totalCalls30d: 26,
      measuredCalls30d: 20,
      estimatedCalls30d: 6,
      localTokensTotal30d: 1300,
      localPromptTokens30d: 500,
      localCompletionTokens30d: 800,
      cloudTokensTotal30d: 2800,
      cloudPromptTokens30d: 1200,
      cloudCompletionTokens30d: 1600,
      measuredTokensTotal30d: 3300,
      estimatedTokensTotal30d: 800,
      measuredCoveragePercent30d: 76.9,
      reasoningTokensTotal30d: 100,
      cloudCostJpyTotal30d: 5.75,
      cloudModel: "gpt-5-4-mini",
      cloudInputCostJpyPerMTokens: 165,
      cloudOutputCostJpyPerMTokens: 660,
    },
    daily: [
      {
        day: "2026-05-19",
        localPromptTokens: 100,
        localCompletionTokens: 150,
        localReasoningTokens: 0,
        cloudPromptTokens: 200,
        cloudCompletionTokens: 250,
        cloudReasoningTokens: 20,
        totalTokens: 700,
        measuredTokens: 700,
        estimatedTokens: 0,
        measuredCalls: 4,
        estimatedCalls: 0,
        costJpy: 1.5,
      },
      {
        day: "2026-05-20",
        localPromptTokens: 120,
        localCompletionTokens: 180,
        localReasoningTokens: 0,
        cloudPromptTokens: 220,
        cloudCompletionTokens: 320,
        cloudReasoningTokens: 30,
        totalTokens: 840,
        measuredTokens: 640,
        estimatedTokens: 200,
        measuredCalls: 3,
        estimatedCalls: 1,
        costJpy: 2.25,
      },
    ],
    bySource: [
      {
        source: "context-compiler",
        calls: 12,
        measuredCalls: 10,
        estimatedCalls: 2,
        promptTokens: 1100,
        completionTokens: 900,
        totalTokens: 2000,
      },
      {
        source: "find-candidate",
        calls: 8,
        measuredCalls: 5,
        estimatedCalls: 3,
        promptTokens: 600,
        completionTokens: 500,
        totalTokens: 1100,
      },
    ],
  },
  searchApiStatus: {
    brave: {
      status: "cooldown",
      cooldownUntil: "2026-05-20T00:10:00.000Z",
      lastError: "Brave search HTTP 429",
    },
    exa: {
      status: "ok",
      cooldownUntil: null,
      lastError: null,
    },
  },
});

describe("API route contract tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listAuditLogsForApi).mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      limit: 50,
      availableEventTypes: [],
    });
    vi.mocked(compilePackForApi).mockResolvedValue(validCompileResponse);
    vi.mocked(listRunsForApi).mockResolvedValue([]);
    vi.mocked(getRunDetailForApi).mockResolvedValue(validRunDetail);
    vi.mocked(saveRunKnowledgeFeedbackForApi).mockResolvedValue(validRunKnowledgeFeedback);
    vi.mocked(getDoctorReportForApi).mockResolvedValue(validDoctorReport);
    vi.mocked(fetchOverviewDashboardForApi).mockResolvedValue(validOverviewDashboard);
    vi.mocked(getSettingsForApi).mockResolvedValue({
      settings: {},
      effective: {},
      sources: {},
      revision: 1,
      loadedAt: "2026-05-23T00:00:00.000Z",
    } as any);
    vi.mocked(updateSettingsForApi).mockResolvedValue({
      settings: {},
      effective: {},
      sources: {},
      revision: 2,
      loadedAt: "2026-05-23T00:00:00.000Z",
      updatedAt: "2026-05-23T00:00:00.000Z",
      cacheInvalidated: true,
      reloadRequired: true,
    } as any);
    vi.mocked(testProviderForApi).mockResolvedValue({
      provider: "openai",
      configured: true,
      reachable: true,
      model: "5.4mini",
      endpoint: "https://api.openai.com/v1",
    });
    vi.mocked(reloadRuntimeCacheForApi).mockResolvedValue({
      ok: true,
      reloadedAt: "2026-05-23T00:00:00.000Z",
    });
    vi.mocked(listCandidateItems).mockResolvedValue({
      items: [],
      total: 0,
      stats: {
        total: 0,
        stored: 0,
        readyNotFinalized: 0,
        rejected: 0,
        retryable: 0,
        targetPending: 0,
        candidateOnly: 0,
      },
    });
    vi.mocked(listKnowledgeItems).mockResolvedValue([]);
    vi.mocked(listKnowledgeTagDefinitionsForApi).mockResolvedValue([]);
    vi.mocked(countKnowledgeItems).mockResolvedValue(0);
    vi.mocked(bulkUpdateKnowledgeStatus).mockResolvedValue({
      targetStatus: "active",
      requestedIds: [],
      updatedIds: [],
      unchangedIds: [],
      notFoundIds: [],
      invalidTransitionIds: [],
    });
    vi.mocked(createKnowledgeItem).mockResolvedValue({ id: "new-item-id" });
    vi.mocked(updateKnowledgeItem).mockResolvedValue({ id: "updated-item-id" });
    vi.mocked(deleteKnowledgeItem).mockResolvedValue({ id: "deleted-item-id" });
    vi.mocked(recordKnowledgeFeedback).mockResolvedValue({
      id: "updated-item-id",
      direction: "up",
      explicitUpvoteCount: 1,
      explicitDownvoteCount: 0,
      dynamicScore: 42,
      lastVerifiedAt: new Date("2026-05-15T00:00:00.000Z"),
    });
    vi.mocked(recordVibeMemoryWithDiffEntries).mockResolvedValue({
      memory: {
        id: "550e8400-e29b-41d4-a716-446655440001",
        sessionId: "session-1",
        content: "saved memory",
        memoryType: "chat",
        dedupeKey: null,
        embedding: null,
        metadata: {},
        createdAt: "2026-05-15T00:00:00.000Z",
      } as never,
      diffEntries: [],
    });
  });

  test("adminApiKeyAuth rejects missing key when configured", async () => {
    const originalApiKey = groupedConfig.admin.apiKey;
    groupedConfig.admin.apiKey = "test-admin-key";
    try {
      const app = new Hono();
      app.use("/api/*", adminApiKeyAuth());
      app.get("/api/knowledge", (ctx) => ctx.json({ ok: true }));

      const unauthorized = await app.request("/api/knowledge");
      expect(unauthorized.status).toBe(401);

      const authorized = await app.request("/api/knowledge", {
        headers: { "x-admin-api-key": "test-admin-key" },
      });
      expect(authorized.status).toBe(200);
      await expect(authorized.json()).resolves.toEqual({ ok: true });

      const authorizedByBearer = await app.request("/api/knowledge", {
        headers: { authorization: "Bearer test-admin-key" },
      });
      expect(authorizedByBearer.status).toBe(200);

      const rejectedQueryKey = await app.request("/api/knowledge?api_key=test-admin-key");
      expect(rejectedQueryKey.status).toBe(401);
    } finally {
      groupedConfig.admin.apiKey = originalApiKey;
    }
  });

  test("adminApiKeyAuth bypasses health endpoints and OPTIONS preflight", async () => {
    const originalApiKey = groupedConfig.admin.apiKey;
    groupedConfig.admin.apiKey = "test-admin-key";
    try {
      const app = new Hono();
      app.use("/api/*", adminApiKeyAuth());
      app.get("/api/health", (ctx) => ctx.json({ ok: true }));
      app.get("/api/health/ready", (ctx) => ctx.json({ ok: true }));
      app.options("/api/knowledge", (ctx) => ctx.body(null, 204));

      const health = await app.request("/api/health");
      expect(health.status).toBe(200);

      const healthReady = await app.request("/api/health/ready");
      expect(healthReady.status).toBe(200);

      const preflight = await app.request("/api/knowledge", { method: "OPTIONS" });
      expect(preflight.status).toBe(204);
    } finally {
      groupedConfig.admin.apiKey = originalApiKey;
    }
  });

  test("app health endpoints return liveness/readiness payloads", async () => {
    const health = await app.request("/api/health");
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ status: "ok", service: "memory-router-api" });

    const live = await app.request("/api/health/live");
    expect(live.status).toBe(200);
    await expect(live.json()).resolves.toEqual({ status: "alive", service: "memory-router-api" });

    const ready = await app.request("/api/health/ready");
    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toEqual({ status: "ready", service: "memory-router-api" });
  });

  test("GET /api/audit-logs rejects invalid query", async () => {
    const app = buildApp();
    const response = await app.request("/api/audit-logs?actor=invalid");

    expect(response.status).toBe(400);
    expect(listAuditLogsForApi).not.toHaveBeenCalled();
  });

  test("GET /api/audit-logs returns pagination payload", async () => {
    vi.mocked(listAuditLogsForApi).mockResolvedValueOnce({
      items: [
        {
          id: "550e8400-e29b-41d4-a716-446655440020",
          eventType: "CONTEXT_COMPILE_RUN",
          actor: "agent",
          payload: { runId: "run-1" },
          createdAt: new Date("2026-05-15T00:00:00.000Z"),
        },
      ],
      total: 1,
      page: 1,
      limit: 20,
      availableEventTypes: ["CONTEXT_COMPILE_RUN"],
    });

    const app = buildApp();
    const response = await app.request("/api/audit-logs?page=1&limit=20");
    const json = (await response.json()) as {
      items: Array<{ eventType: string; actor: string }>;
      availableEventTypes: string[];
      pagination: {
        page: number;
        limit: number;
        total: number;
        totalPages: number;
        hasNextPage: boolean;
      };
    };

    expect(response.status).toBe(200);
    expect(json.items).toHaveLength(1);
    expect(json.items[0]?.eventType).toBe("CONTEXT_COMPILE_RUN");
    expect(json.items[0]?.actor).toBe("agent");
    expect(json.availableEventTypes).toEqual(["CONTEXT_COMPILE_RUN"]);
    expect(json.pagination).toEqual({
      page: 1,
      limit: 20,
      total: 1,
      totalPages: 1,
      hasNextPage: false,
    });
    expect(listAuditLogsForApi).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1, limit: 20 }),
    );
  });

  test("GET /api/candidates rejects invalid query", async () => {
    const app = buildApp();
    const response = await app.request("/api/candidates?limit=0");
    expect(response.status).toBe(400);
    expect(listCandidateItems).not.toHaveBeenCalled();
  });

  test("GET /api/candidates returns list and stats payload", async () => {
    vi.mocked(listCandidateItems).mockResolvedValueOnce({
      items: [
        {
          id: "candidate-1",
          targetStateId: "target-1",
          candidateIndex: 0,
          targetKind: "wiki_file",
          targetKey: "docs/guide.md",
          sourceUri: "file:///workspace/docs/guide.md",
          finalizeSourceUri: "cover-evidence-result://candidate-1",
          targetStatus: "completed",
          targetPhase: "stored",
          targetOutcomeKind: "knowledge_finalized",
          targetLastError: null,
          latestUpdatedAt: "2026-05-20T00:00:00.000Z",
          original: {
            title: "Original title",
            body: "Original body",
            status: "selected",
            createdAt: "2026-05-20T00:00:00.000Z",
            updatedAt: "2026-05-20T00:00:00.000Z",
          },
          cover: {
            status: "knowledge_ready",
            stage: "final",
            type: "rule",
            title: "Covered title",
            body: "Covered body",
            importance: 80,
            confidence: 75,
            reason: null,
            referencesCount: 1,
            duplicateRefsCount: 0,
            toolEventsCount: 1,
            updatedAt: "2026-05-20T00:00:00.000Z",
          },
          knowledge: {
            id: "knowledge-1",
            type: "rule",
            status: "draft",
            scope: "repo",
            title: "Knowledge title",
            body: "Knowledge body",
            importance: 80,
            confidence: 75,
            updatedAt: "2026-05-20T00:00:00.000Z",
          },
          outcome: "stored",
          landscapeWarning: null,
          diff: {
            originalToCover: {
              titleChanged: true,
              bodyChanged: true,
              typeChanged: true,
              importanceDelta: null,
              confidenceDelta: null,
              bodySimilarity: 0.5,
              summary: ["title changed"],
            },
            coverToKnowledge: null,
            originalToKnowledge: null,
          },
        },
      ],
      total: 1,
      stats: {
        total: 1,
        stored: 1,
        readyNotFinalized: 0,
        rejected: 0,
        retryable: 0,
        targetPending: 0,
        candidateOnly: 0,
      },
    });

    const app = buildApp();
    const response = await app.request(
      "/api/candidates?limit=1&page=1&outcome=stored&sortBy=candidateTitle&sortDir=asc",
    );
    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      items: Array<{ id: string; outcome: string }>;
      total: number;
      page: number;
      limit: number;
      totalPages: number;
      stats: { stored: number; total: number };
    };

    expect(json.items).toHaveLength(1);
    expect(json.items[0]?.id).toBe("candidate-1");
    expect(json.items[0]?.outcome).toBe("stored");
    expect(json.total).toBe(1);
    expect(json.page).toBe(1);
    expect(json.limit).toBe(1);
    expect(json.totalPages).toBe(1);
    expect(json.stats).toMatchObject({ total: 1, stored: 1 });
    expect(listCandidateItems).toHaveBeenCalledWith(
      expect.objectContaining({
        page: 1,
        limit: 1,
        outcome: "stored",
        sortBy: "candidateTitle",
        sortDir: "asc",
      }),
    );
  });

  test("POST /api/context/compile returns 400 for invalid request body", async () => {
    const app = buildApp();
    const response = await app.request("/api/context/compile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal: "" }),
    });

    expect(response.status).toBe(400);
    expect(compilePackForApi).not.toHaveBeenCalled();
  });

  test("POST /api/context/compile returns contract-compatible response", async () => {
    const app = buildApp();
    const response = await app.request("/api/context/compile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal: "api contract goal", changeTypes: ["feature"] }),
    });

    expect(response.status).toBe(200);
    const json = (await response.json()) as { pack: unknown; markdown: unknown };
    const parsed = contextPackSchema.parse(json.pack);
    expect(parsed.goal).toBe("api contract goal");
    expect(typeof json.markdown).toBe("string");
    expect(compilePackForApi).toHaveBeenCalledWith(
      expect.objectContaining({ goal: "api contract goal", changeTypes: ["feature"] }),
    );
  });

  test("GET /api/context/runs/:id returns run detail", async () => {
    const app = buildApp();
    const response = await app.request(`/api/context/runs/${validPack.runId}`);

    expect(response.status).toBe(200);
    const json = (await response.json()) as { detail: unknown };
    const parsed = compileRunDetailSchema.parse(json.detail);
    expect(parsed.pack?.runId).toBe(validPack.runId);
    expect(getRunDetailForApi).toHaveBeenCalledWith({ id: validPack.runId });
  });

  test("GET /api/context/runs/:id returns 404 for missing run", async () => {
    vi.mocked(getRunDetailForApi).mockResolvedValueOnce(null);
    const app = buildApp();
    const response = await app.request(`/api/context/runs/${validPack.runId}`);

    expect(response.status).toBe(404);
  });

  test("GET /api/context/runs/:id rejects invalid run id", async () => {
    const app = buildApp();
    const response = await app.request("/api/context/runs/not-a-uuid");

    expect(response.status).toBe(400);
    expect(getRunDetailForApi).not.toHaveBeenCalled();
  });

  test("POST /api/context/runs/:id/knowledge-feedback returns persisted summary", async () => {
    const app = buildApp();
    const runId = validPack.runId;
    const response = await app.request(`/api/context/runs/${runId}/knowledge-feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: [
          {
            knowledgeId: "550e8400-e29b-41d4-a716-446655440001",
            verdict: "used",
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    expect(saveRunKnowledgeFeedbackForApi).toHaveBeenCalledWith(
      { id: runId },
      {
        items: [{ knowledgeId: "550e8400-e29b-41d4-a716-446655440001", verdict: "used" }],
      },
    );
    const json = (await response.json()) as { feedback: typeof validRunKnowledgeFeedback };
    expect(json.feedback.savedCount).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(json.feedback.affectedKnowledgeIds)).toBe(true);
  });

  test("POST /api/context/runs/:id/knowledge-feedback rejects invalid payload", async () => {
    const app = buildApp();
    const runId = validPack.runId;
    const response = await app.request(`/api/context/runs/${runId}/knowledge-feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: [{ knowledgeId: "not-uuid", verdict: "used" }],
      }),
    });

    expect(response.status).toBe(400);
    expect(saveRunKnowledgeFeedbackForApi).not.toHaveBeenCalled();
  });

  test("GET /api/doctor returns contract-compatible response", async () => {
    const app = buildApp();
    const response = await app.request("/api/doctor");

    expect(response.status).toBe(200);
    const json = await response.json();
    const parsed = doctorReportSchema.parse(json);
    expect(parsed.status).toBe("ok");
    expect(getDoctorReportForApi).toHaveBeenCalledTimes(1);
  });

  test("GET /api/overview returns contract-compatible response", async () => {
    const app = buildApp();
    const response = await app.request("/api/overview");

    expect(response.status).toBe(200);
    const json = await response.json();
    const parsed = overviewDashboardSchema.parse(json);
    expect(parsed.kpis.knowledgeTotal).toBe(334);
    expect(parsed.charts.dynamicScoreBuckets).toHaveLength(10);
    expect(fetchOverviewDashboardForApi).toHaveBeenCalledTimes(1);
  });

  test("GET /api/settings returns payload", async () => {
    const app = buildApp();
    const response = await app.request("/api/settings");
    const json = (await response.json()) as {
      settings: unknown;
      revision: number;
    };

    expect(response.status).toBe(200);
    expect(json.revision).toBe(1);
    expect(getSettingsForApi).toHaveBeenCalledTimes(1);
  });

  test("PUT /api/settings rejects invalid payload", async () => {
    const app = buildApp();
    const response = await app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings: {} }),
    });

    expect(response.status).toBe(400);
    expect(updateSettingsForApi).not.toHaveBeenCalled();
  });

  test("POST /api/settings/providers/:provider/test returns provider health", async () => {
    const app = buildApp();
    const response = await app.request("/api/settings/providers/openai/test", {
      method: "POST",
    });
    const json = (await response.json()) as {
      provider: string;
      health: {
        configured: boolean;
        reachable: boolean;
      };
    };

    expect(response.status).toBe(200);
    expect(json.provider).toBe("openai");
    expect(json.health.configured).toBe(true);
    expect(testProviderForApi).toHaveBeenCalledWith("openai");
  });

  test("POST /api/settings/reload-runtime-cache returns reload result", async () => {
    const app = buildApp();
    const response = await app.request("/api/settings/reload-runtime-cache", {
      method: "POST",
    });
    const json = (await response.json()) as {
      ok: boolean;
      reloadedAt: string;
    };

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.reloadedAt).toBe("2026-05-23T00:00:00.000Z");
    expect(reloadRuntimeCacheForApi).toHaveBeenCalledTimes(1);
  });

  test("GET /api/knowledge rejects invalid query", async () => {
    const app = buildApp();
    const response = await app.request("/api/knowledge?limit=0");

    expect(response.status).toBe(400);
    expect(listKnowledgeItems).not.toHaveBeenCalled();
    expect(countKnowledgeItems).not.toHaveBeenCalled();
  });

  test("GET /api/knowledge/tags returns tag definitions", async () => {
    vi.mocked(listKnowledgeTagDefinitionsForApi).mockResolvedValueOnce([
      {
        id: "550e8400-e29b-41d4-a716-446655440004",
        kind: "technology",
        slug: "typescript",
        label: "TypeScript",
        description: null,
        aliases: ["ts"],
        status: "active",
        sortOrder: 10,
      },
    ]);
    const app = buildApp();
    const response = await app.request("/api/knowledge/tags?kind=technology&status=active");
    const json = (await response.json()) as {
      tags: Array<{ slug: string }>;
    };

    expect(response.status).toBe(200);
    expect(json.tags).toHaveLength(1);
    expect(json.tags[0]?.slug).toBe("typescript");
    expect(listKnowledgeTagDefinitionsForApi).toHaveBeenCalledWith({
      kind: "technology",
      status: "active",
    });
  });

  test("GET /api/knowledge returns list shape used by web repository", async () => {
    vi.mocked(listKnowledgeItems).mockResolvedValueOnce([
      {
        id: "550e8400-e29b-41d4-a716-446655440002",
        type: "rule",
        status: "active",
        scope: "repo",
        title: "Knowledge title",
        body: "Knowledge body",
        confidence: 80,
        importance: 70,
        appliesTo: {},
        metadata: {},
        sourceRefs: [],
        sourceVibeMemoryIds: [],
        compileSelectCount: 0,
        lastCompiledAt: null,
        agenticAcceptCount: 0,
        explicitUpvoteCount: 0,
        explicitDownvoteCount: 0,
        dynamicScore: 0,
        decayFactor: 1,
        lastVerifiedAt: null,
        createdAt: new Date("2026-05-15T00:00:00.000Z"),
        updatedAt: new Date("2026-05-15T00:00:00.000Z"),
      },
    ]);
    vi.mocked(countKnowledgeItems).mockResolvedValueOnce(260);

    const app = buildApp();
    const response = await app.request("/api/knowledge?limit=1&page=2");
    const json = (await response.json()) as {
      items: Array<{ id: string; title: string }>;
      total: number;
      page: number;
      limit: number;
      totalPages: number;
    };

    expect(response.status).toBe(200);
    expect(json.items).toHaveLength(1);
    expect(json.total).toBe(260);
    expect(json.page).toBe(2);
    expect(json.limit).toBe(1);
    expect(json.totalPages).toBe(260);
    expect(json.items[0]?.id).toBe("550e8400-e29b-41d4-a716-446655440002");
    expect(json.items[0]?.title).toBe("Knowledge title");
    expect(listKnowledgeItems).toHaveBeenCalledWith({
      limit: 1,
      page: 2,
      sortBy: "updatedAt",
      sortDir: "desc",
    });
    expect(countKnowledgeItems).toHaveBeenCalledWith({
      limit: 1,
      page: 2,
      sortBy: "updatedAt",
      sortDir: "desc",
    });
  });

  test("GET /api/knowledge passes server-side sort parameters", async () => {
    vi.mocked(listKnowledgeItems).mockResolvedValueOnce([]);
    vi.mocked(countKnowledgeItems).mockResolvedValueOnce(0);

    const app = buildApp();
    const response = await app.request("/api/knowledge?limit=20&page=3&sortBy=title&sortDir=asc");

    expect(response.status).toBe(200);
    expect(listKnowledgeItems).toHaveBeenCalledWith({
      limit: 20,
      page: 3,
      sortBy: "title",
      sortDir: "asc",
    });
  });

  test("PUT /api/knowledge/:id rejects invalid payload", async () => {
    const app = buildApp();
    const response = await app.request("/api/knowledge/invalid-id", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "rule",
        status: "active",
        scope: "repo",
        title: "",
        body: "body",
      }),
    });

    expect(response.status).toBe(400);
    expect(updateKnowledgeItem).not.toHaveBeenCalled();
  });

  test("PUT /api/knowledge/:id returns 404 when item does not exist", async () => {
    vi.mocked(updateKnowledgeItem).mockResolvedValueOnce(null as any);

    const app = buildApp();
    const response = await app.request("/api/knowledge/550e8400-e29b-41d4-a716-446655440003", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "rule",
        status: "active",
        scope: "repo",
        title: "Updated title",
        body: "Updated body",
        confidence: 70,
        importance: 70,
        metadata: {},
      }),
    });

    expect(response.status).toBe(404);
    const json = (await response.json()) as { error: string };
    expect(json.error).toBe("not found");
  });

  test("PUT /api/knowledge/:id accepts patch payload", async () => {
    vi.mocked(updateKnowledgeItem).mockResolvedValueOnce({ id: "updated-item-id" } as any);

    const app = buildApp();
    const response = await app.request("/api/knowledge/550e8400-e29b-41d4-a716-446655440003", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        status: "deprecated",
      }),
    });

    expect(response.status).toBe(200);
    expect(updateKnowledgeItem).toHaveBeenCalledWith("550e8400-e29b-41d4-a716-446655440003", {
      status: "deprecated",
    });
  });

  test("PUT /api/knowledge/:id keeps unknown appliesTo keys", async () => {
    vi.mocked(updateKnowledgeItem).mockResolvedValueOnce({ id: "updated-item-id" } as any);

    const app = buildApp();
    const response = await app.request("/api/knowledge/550e8400-e29b-41d4-a716-446655440003", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        appliesTo: {
          general: true,
          customFacet: ["alpha", "beta"],
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(updateKnowledgeItem).toHaveBeenCalledWith("550e8400-e29b-41d4-a716-446655440003", {
      appliesTo: {
        general: true,
        customFacet: ["alpha", "beta"],
      },
    });
  });

  test("POST /api/knowledge/bulk-status returns partial update summary", async () => {
    vi.mocked(bulkUpdateKnowledgeStatus).mockResolvedValueOnce({
      targetStatus: "active",
      requestedIds: ["k1", "k2"],
      updatedIds: ["k1"],
      unchangedIds: [],
      notFoundIds: ["k2"],
      invalidTransitionIds: [],
    });
    const app = buildApp();
    const response = await app.request("/api/knowledge/bulk-status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ids: ["k1", "k2"],
        status: "active",
      }),
    });

    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      outcome: string;
      updatedIds: string[];
      notFoundIds: string[];
    };
    expect(json.outcome).toBe("partial");
    expect(json.updatedIds).toEqual(["k1"]);
    expect(json.notFoundIds).toEqual(["k2"]);
  });

  test("POST /api/knowledge/bulk-status accepts status selection", async () => {
    vi.mocked(bulkUpdateKnowledgeStatus).mockResolvedValueOnce({
      targetStatus: "active",
      requestedIds: ["k1", "k2", "k3"],
      updatedIds: ["k1", "k2", "k3"],
      unchangedIds: [],
      notFoundIds: [],
      invalidTransitionIds: [],
    });
    const app = buildApp();
    const response = await app.request("/api/knowledge/bulk-status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        selection: { status: "draft", query: "router" },
        status: "active",
      }),
    });

    expect(response.status).toBe(200);
    expect(bulkUpdateKnowledgeStatus).toHaveBeenCalledWith({
      selection: { status: "draft", query: "router" },
      status: "active",
    });
    const json = (await response.json()) as {
      outcome: string;
      updatedIds: string[];
    };
    expect(json.outcome).toBe("ok");
    expect(json.updatedIds).toEqual(["k1", "k2", "k3"]);
  });

  test("POST /api/knowledge/bulk-status accepts all item selection", async () => {
    vi.mocked(bulkUpdateKnowledgeStatus).mockResolvedValueOnce({
      targetStatus: "deprecated",
      requestedIds: ["k1", "k2"],
      updatedIds: ["k1", "k2"],
      unchangedIds: [],
      notFoundIds: [],
      invalidTransitionIds: [],
    });
    const app = buildApp();
    const response = await app.request("/api/knowledge/bulk-status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        selection: {},
        status: "deprecated",
      }),
    });

    expect(response.status).toBe(200);
    expect(bulkUpdateKnowledgeStatus).toHaveBeenCalledWith({
      selection: {},
      status: "deprecated",
    });
    const json = (await response.json()) as {
      outcome: string;
      updatedIds: string[];
    };
    expect(json.outcome).toBe("ok");
    expect(json.updatedIds).toEqual(["k1", "k2"]);
  });

  test("POST /api/knowledge/bulk-status returns 409 when nothing can be updated", async () => {
    vi.mocked(bulkUpdateKnowledgeStatus).mockResolvedValueOnce({
      targetStatus: "deprecated",
      requestedIds: ["k1"],
      updatedIds: [],
      unchangedIds: [],
      notFoundIds: [],
      invalidTransitionIds: [{ id: "k1", fromStatus: "draft" }],
    });

    const app = buildApp();
    const response = await app.request("/api/knowledge/bulk-status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ids: ["k1"],
        status: "deprecated",
      }),
    });

    expect(response.status).toBe(409);
    const json = (await response.json()) as { outcome: string };
    expect(json.outcome).toBe("none");
  });

  test("POST /api/knowledge/:id/feedback returns payload", async () => {
    const app = buildApp();
    const response = await app.request(
      "/api/knowledge/550e8400-e29b-41d4-a716-446655440003/feedback",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ direction: "up" }),
      },
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      feedback: { id: string; direction: string };
    };
    expect(json.feedback.id).toBe("updated-item-id");
    expect(json.feedback.direction).toBe("up");
  });

  test("POST /api/vibe-memory rejects invalid payload", async () => {
    const app = buildApp();
    const response = await app.request("/api/vibe-memory", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "" }),
    });

    expect(response.status).toBe(400);
    expect(recordVibeMemoryWithDiffEntries).not.toHaveBeenCalled();
  });

  test("POST /api/vibe-memory returns created payload", async () => {
    const app = buildApp();
    const response = await app.request("/api/vibe-memory", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "session-1",
        content: "memory body",
      }),
    });

    expect(response.status).toBe(201);
    const json = (await response.json()) as {
      memory: { sessionId: string; memoryType: string };
      diffEntries: unknown[];
    };
    expect(json.memory.sessionId).toBe("session-1");
    expect(json.memory.memoryType).toBe("chat");
    expect(Array.isArray(json.diffEntries)).toBe(true);
  });
});
