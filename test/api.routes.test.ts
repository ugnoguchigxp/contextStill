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
  getRunRankingTraceForApi,
  listRunsForApi,
  saveRunKnowledgeFeedbackForApi,
} from "../api/modules/context-compiler/context-compiler.service.js";
import { doctorRouter } from "../api/modules/doctor/doctor.routes.js";
import {
  getDoctorDomainForApi,
  getDoctorReportForApi,
} from "../api/modules/doctor/doctor.service.js";
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
import {
  fetchOverviewDashboardForApi,
  fetchOverviewDomainForApi,
} from "../api/modules/overview/overview.repository.js";
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
import {
  CoverEvidenceReprocessError,
  requestCoverEvidenceReprocess,
} from "../src/modules/coverEvidence/reprocess-candidate.service.js";
import { recordVibeMemoryWithDiffEntries } from "../src/modules/vibe-memory/vibe-memory.service.js";
import { compileRunDetailSchema } from "../src/shared/schemas/compile-run.schema.js";
import { type ContextPack, contextPackSchema } from "../src/shared/schemas/context-pack.schema.js";
import {
  type DoctorAiServiceToolsDomain,
  type DoctorCoreInfrastructureDomain,
  type DoctorPipelineAutomationDomain,
  type DoctorReport,
  doctorAiServiceToolsDomainSchema,
  doctorCoreInfrastructureDomainSchema,
  doctorPipelineAutomationDomainSchema,
  doctorReportSchema,
} from "../src/shared/schemas/doctor.schema.js";
import {
  type OverviewDashboard,
  overviewDashboardSchema,
  overviewKnowledgeAssetsDomainSchema,
  overviewLandscapeHealthDomainSchema,
  overviewLlmResourcesDomainSchema,
  overviewSystemQualityDomainSchema,
} from "../src/shared/schemas/overview.schema.js";

vi.mock("../api/modules/context-compiler/context-compiler.service.js", () => ({
  compilePackForApi: vi.fn(),
  getRunDetailForApi: vi.fn(),
  getRunRankingTraceForApi: vi.fn(),
  getRunDetailParamSchema: z.object({
    id: z.string().uuid(),
  }),
  getRunRankingTraceParamSchema: z.object({
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

const validRunRankingTrace = {
  run: {
    id: validPack.runId,
    goal: "api contract goal",
    repoPath: null,
    retrievalMode: "task_context",
    status: "ok",
    input: {},
    createdAt: "2026-05-23T00:00:00.000Z",
  },
  evalSummary: {
    count: 1,
    latestAvg: 90,
    latestOutcome: "useful",
  },
  feedbackSummary: {
    used: 1,
    notUsed: 0,
    offTopic: 0,
    wrong: 0,
    noSignal: 0,
  },
  funnel: {
    textHitCount: 1,
    vectorHitCount: 1,
    mergedCount: 1,
    finalCount: 1,
    packedCount: 1,
    selectedCount: 1,
    suppressedCount: 0,
  },
  items: [],
} as const;

vi.mock("../api/modules/doctor/doctor.service.js", () => ({
  getDoctorDomainForApi: vi.fn(),
  getDoctorReportForApi: vi.fn(),
}));

vi.mock("../api/modules/overview/overview.repository.js", () => ({
  fetchOverviewDashboardForApi: vi.fn(),
  fetchOverviewDomainForApi: vi.fn(),
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
    "retained_failure",
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

vi.mock("../src/modules/coverEvidence/reprocess-candidate.service.js", () => ({
  CoverEvidenceReprocessError: class CoverEvidenceReprocessError extends Error {
    statusCode: 404 | 409;
    reason: string;

    constructor(statusCode: 404 | 409, reason: string) {
      super(reason);
      this.name = "CoverEvidenceReprocessError";
      this.statusCode = statusCode;
      this.reason = reason;
    }
  },
  requestCoverEvidenceReprocess: vi.fn(),
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

import {
  validCompileResponse,
  validDoctorAiServiceTools,
  validDoctorCoreInfrastructure,
  validDoctorPipelineAutomation,
  validDoctorReport,
  validOverviewDashboard,
  validOverviewKnowledgeAssets,
  validOverviewLandscapeHealth,
  validOverviewLlmResources,
  validOverviewSystemQuality,
  validPack,
  validRunDetail,
  validRunKnowledgeFeedback,
} from "./fixtures/api-route-contract-fixtures.js";

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
    vi.mocked(getRunRankingTraceForApi).mockResolvedValue(validRunRankingTrace as any);
    vi.mocked(saveRunKnowledgeFeedbackForApi).mockResolvedValue(validRunKnowledgeFeedback);
    vi.mocked(getDoctorReportForApi).mockResolvedValue(validDoctorReport);
    vi.mocked(getDoctorDomainForApi).mockImplementation(async (domain) => {
      if (domain === "core-infrastructure") return validDoctorCoreInfrastructure;
      if (domain === "ai-service-tools") return validDoctorAiServiceTools;
      return validDoctorPipelineAutomation;
    });
    vi.mocked(fetchOverviewDashboardForApi).mockResolvedValue(validOverviewDashboard);
    vi.mocked(fetchOverviewDomainForApi).mockImplementation(async (domain) => {
      if (domain === "knowledge-assets") return validOverviewKnowledgeAssets;
      if (domain === "landscape-health") return validOverviewLandscapeHealth;
      if (domain === "system-quality") return validOverviewSystemQuality;
      return validOverviewLlmResources;
    });
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
        retainedFailure: 0,
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
    vi.mocked(requestCoverEvidenceReprocess).mockResolvedValue({
      findCandidateResultId: "candidate-1",
      coverEvidenceResultId: "candidate-1",
      targetStateId: "target-1",
      status: "queued",
      mode: "cloud_api",
      previousStatus: "insufficient",
      previousReason: "rule_body_not_actionable",
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
    await expect(health.json()).resolves.toEqual({ status: "ok", service: "context-still-api" });

    const live = await app.request("/api/health/live");
    expect(live.status).toBe(200);
    await expect(live.json()).resolves.toEqual({ status: "alive", service: "context-still-api" });

    const ready = await app.request("/api/health/ready");
    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toEqual({ status: "ready", service: "context-still-api" });
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
        retainedFailure: 0,
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

  test("POST /api/candidates/:id/premium-reprocess queues candidate", async () => {
    const app = buildApp();
    const response = await app.request("/api/candidates/candidate-1/premium-reprocess", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    const json = (await response.json()) as {
      result: {
        status: string;
        mode: string;
      };
    };

    expect(response.status).toBe(200);
    expect(json.result).toMatchObject({
      status: "queued",
      mode: "cloud_api",
    });
    expect(requestCoverEvidenceReprocess).toHaveBeenCalledWith({
      findCandidateResultId: "candidate-1",
      mode: "cloud_api",
      forceRefreshEvidence: true,
      actor: "user",
    });
  });

  test("POST /api/candidates/:id/premium-reprocess maps domain reason errors", async () => {
    vi.mocked(requestCoverEvidenceReprocess).mockRejectedValueOnce(
      new CoverEvidenceReprocessError(409, "target_running"),
    );
    const app = buildApp();
    const response = await app.request("/api/candidates/candidate-1/premium-reprocess", {
      method: "POST",
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      reason: "target_running",
    });
  });

  test("POST /api/candidates/:id/premium-reprocess rejects malformed request body", async () => {
    const app = buildApp();
    const response = await app.request("/api/candidates/candidate-1/premium-reprocess", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: "{",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      reason: "invalid_request_body",
    });
    expect(requestCoverEvidenceReprocess).not.toHaveBeenCalled();
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

  test("GET /api/context/runs/:id/ranking-trace returns run ranking trace", async () => {
    const app = buildApp();
    const response = await app.request(`/api/context/runs/${validPack.runId}/ranking-trace`);

    expect(response.status).toBe(200);
    const json = (await response.json()) as { trace: { run: { id: string } } };
    expect(json.trace.run.id).toBe(validPack.runId);
    expect(getRunRankingTraceForApi).toHaveBeenCalledWith({ id: validPack.runId });
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
});
