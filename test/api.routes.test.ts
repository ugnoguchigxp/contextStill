import { Hono } from "hono";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { contextCompilerRouter } from "../api/modules/context-compiler/context-compiler.routes.js";
import {
  compilePackForApi,
  listRunsForApi,
} from "../api/modules/context-compiler/context-compiler.service.js";
import { doctorRouter } from "../api/modules/doctor/doctor.routes.js";
import { getDoctorReportForApi } from "../api/modules/doctor/doctor.service.js";
import {
  createKnowledgeItem,
  deleteKnowledgeItem,
  listKnowledgeItems,
  updateKnowledgeItem,
} from "../api/modules/knowledge/knowledge.repository.js";
import { knowledgeRouter } from "../api/modules/knowledge/knowledge.routes.js";
import { vibeMemoryRouter } from "../api/modules/vibe-memory/vibe-memory.routes.js";
import { recordVibeMemoryWithDiffEntries } from "../src/modules/vibe-memory/vibe-memory.service.js";
import { type ContextPack, contextPackSchema } from "../src/shared/schemas/context-pack.schema.js";
import { type DoctorReport, doctorReportSchema } from "../src/shared/schemas/doctor.schema.js";

vi.mock("../api/modules/context-compiler/context-compiler.service.js", () => ({
  compilePackForApi: vi.fn(),
  listRunsForApi: vi.fn(),
  listRunsQuerySchema: z.object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
  }),
}));

vi.mock("../api/modules/doctor/doctor.service.js", () => ({
  getDoctorReportForApi: vi.fn(),
}));

vi.mock("../api/modules/knowledge/knowledge.repository.js", () => ({
  createKnowledgeItem: vi.fn(),
  deleteKnowledgeItem: vi.fn(),
  listKnowledgeItems: vi.fn(),
  updateKnowledgeItem: vi.fn(),
}));

vi.mock("../src/modules/vibe-memory/vibe-memory.service.js", () => ({
  recordVibeMemoryWithDiffEntries: vi.fn(),
}));

const buildApp = () => {
  const app = new Hono();
  app.route("/api/context", contextCompilerRouter);
  app.route("/api/doctor", doctorRouter);
  app.route("/api/knowledge", knowledgeRouter);
  app.route("/api/vibe-memory", vibeMemoryRouter);
  return app;
};

const validPack: ContextPack = {
  runId: "550e8400-e29b-41d4-a716-446655440000",
  goal: "api contract goal",
  intent: "edit",
  retrievalMode: "task_context",
  status: "ok",
  minimalTasks: ["Inspect relevant knowledge and source material"],
  rules: [],
  procedures: [],
  codeContext: [],
  warnings: [],
  sourceRefs: ["memory-router://packs/run/550e8400-e29b-41d4-a716-446655440000#full"],
  diagnostics: {
    degradedReasons: [],
    retrievalStats: {},
  },
};

const validDoctorReport: DoctorReport = {
  status: "ok",
  checkedAt: "2026-05-15T00:00:00.000Z",
  reasons: [],
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
    lastRunAt: "2026-05-15T00:00:00.000Z",
    lastRunAgeMinutes: 1,
    freshnessThresholdMinutes: 720,
    degradedRateThreshold: 0.5,
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
      failedRuns: 0,
      lastRunAt: null,
      lastRunAgeMinutes: null,
    },
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
      failedRuns: 0,
      lastRunAt: null,
      lastRunAgeMinutes: null,
    },
    nextActions: [],
  },
};

describe("API route contract tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(compilePackForApi).mockResolvedValue(validPack);
    vi.mocked(listRunsForApi).mockResolvedValue([]);
    vi.mocked(getDoctorReportForApi).mockResolvedValue(validDoctorReport);
    vi.mocked(listKnowledgeItems).mockResolvedValue([]);
    vi.mocked(createKnowledgeItem).mockResolvedValue({ id: "new-item-id" });
    vi.mocked(updateKnowledgeItem).mockResolvedValue({ id: "updated-item-id" });
    vi.mocked(deleteKnowledgeItem).mockResolvedValue({ id: "deleted-item-id" });
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
      body: JSON.stringify({ goal: "api contract goal", intent: "edit" }),
    });

    expect(response.status).toBe(200);
    const json = (await response.json()) as { pack: unknown };
    const parsed = contextPackSchema.parse(json.pack);
    expect(parsed.goal).toBe("api contract goal");
    expect(compilePackForApi).toHaveBeenCalledWith(
      expect.objectContaining({ goal: "api contract goal", intent: "edit", includeDraft: false }),
    );
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

  test("GET /api/knowledge rejects invalid query", async () => {
    const app = buildApp();
    const response = await app.request("/api/knowledge?limit=0");

    expect(response.status).toBe(400);
    expect(listKnowledgeItems).not.toHaveBeenCalled();
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
        metadata: {},
        createdAt: new Date("2026-05-15T00:00:00.000Z"),
        updatedAt: new Date("2026-05-15T00:00:00.000Z"),
      },
    ]);

    const app = buildApp();
    const response = await app.request("/api/knowledge?limit=1");
    const json = (await response.json()) as { items: Array<{ id: string; title: string }> };

    expect(response.status).toBe(200);
    expect(json.items).toHaveLength(1);
    expect(json.items[0]?.id).toBe("550e8400-e29b-41d4-a716-446655440002");
    expect(json.items[0]?.title).toBe("Knowledge title");
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
