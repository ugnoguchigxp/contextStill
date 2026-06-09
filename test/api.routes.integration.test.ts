import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import app from "../api/app.js";
import { db } from "../src/db/client.js";
import { vibeMemories } from "../src/db/schema.js";
import { upsertKnowledgeFromSource } from "../src/modules/knowledge/knowledge.repository.js";
import {
  getRuntimeSettingsSnapshot,
  saveRuntimeSettings,
} from "../src/modules/settings/settings.service.js";
import { compileRunDetailSchema } from "../src/shared/schemas/compile-run.schema.js";
import { contextPackSchema } from "../src/shared/schemas/context-pack.schema.js";
import {
  closeIntegrationDb,
  ensureDbIntegrationReady,
  isDbIntegrationEnabled,
  truncateIntegrationTables,
} from "./helpers/integration.js";

const describeDb = isDbIntegrationEnabled() ? describe : describe.skip;

describeDb("api route integration", () => {
  beforeAll(async () => {
    await ensureDbIntegrationReady();
    const settings = getRuntimeSettingsSnapshot();
    settings.taskRouting.agenticCompile.enabled = false;
    await saveRuntimeSettings({
      settings,
      updatedBy: "integration-test",
    });
  });

  beforeEach(async () => {
    await truncateIntegrationTables();
  });

  afterAll(async () => {
    await closeIntegrationDb();
  });

  test("POST /api/context/compile returns context-pack and markdown", async () => {
    const response = await app.request("/api/context/compile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goal: "integration compile token",
        intent: "edit",
        repoPath: "/workspace/repo-a",
      }),
    });

    expect(response.status).toBe(200);
    const json = (await response.json()) as { pack: unknown; markdown: unknown };
    const parsed = contextPackSchema.parse(json.pack);
    expect(parsed.goal).toBe("integration compile token");
    expect(parsed.retrievalMode).toBe("task_context");
    expect(typeof json.markdown).toBe("string");
  });

  test("POST /api/context/runs/:id/knowledge-feedback persists verdict", async () => {
    const ruleId = await upsertKnowledgeFromSource({
      sourceUri: "file:///integration/feedback-rule.md",
      type: "rule",
      status: "active",
      scope: "repo",
      title: "Feedback rule",
      body: "feedback compile token",
    });

    const compileResponse = await app.request("/api/context/compile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goal: "feedback compile token",
      }),
    });
    expect(compileResponse.status).toBe(200);
    const compileJson = (await compileResponse.json()) as { pack: { runId: string } };
    const runId = compileJson.pack.runId;

    const feedbackResponse = await app.request(`/api/context/runs/${runId}/knowledge-feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: [{ knowledgeId: ruleId, verdict: "used" }],
      }),
    });
    expect(feedbackResponse.status).toBe(200);

    const detailResponse = await app.request(`/api/context/runs/${runId}`);
    expect(detailResponse.status).toBe(200);
    const detailJson = (await detailResponse.json()) as { detail: unknown };
    const parsedDetail = compileRunDetailSchema.parse(detailJson.detail);
    expect(parsedDetail.knowledgeFeedback.some((item) => item.knowledgeId === ruleId)).toBe(true);
  }, 15000);

  test("GET /api/knowledge returns persisted items", async () => {
    await upsertKnowledgeFromSource({
      sourceUri: "file:///integration/knowledge.md",
      type: "rule",
      status: "active",
      scope: "repo",
      title: "Integration Knowledge Rule",
      body: "integration api knowledge token",
      metadata: {
        repoPath: "/workspace/repo-a",
        repoKey: "/workspace/repo-a",
      },
    });

    const response = await app.request("/api/knowledge?limit=20&query=Integration%20Knowledge");
    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      items: Array<{ title: string }>;
      total: number;
      totalPages: number;
    };
    expect(json.items.some((item) => item.title === "Integration Knowledge Rule")).toBe(true);
    expect(json.total).toBe(1);
    expect(json.totalPages).toBe(1);
  });

  test("GET /api/knowledge query matches applicability facets", async () => {
    await upsertKnowledgeFromSource({
      sourceUri: "file:///integration/applicability.md",
      type: "rule",
      status: "active",
      scope: "repo",
      title: "Applicability Facet Rule",
      body: "body without the searched facet token",
      appliesTo: {
        technologies: ["typescript"],
        changeTypes: ["schema"],
        domains: ["knowledge-ui"],
      },
    });

    for (const query of ["typescript", "schema", "knowledge-ui"]) {
      const response = await app.request(`/api/knowledge?limit=20&query=${query}`);
      expect(response.status).toBe(200);
      const json = (await response.json()) as {
        items: Array<{ title: string }>;
        total: number;
      };
      expect(json.items.some((item) => item.title === "Applicability Facet Rule")).toBe(true);
      expect(json.total).toBe(1);
    }
  });

  test("POST /api/context-decisions persists decision detail and Good feedback", async () => {
    await upsertKnowledgeFromSource({
      sourceUri: "file:///integration/context-decision.md",
      type: "procedure",
      status: "active",
      scope: "repo",
      title: "Context decision integration evidence",
      body: "context decision integration token should continue autonomously before asking user",
    });

    const createResponse = await app.request("/api/context-decisions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        decisionPoint: "continue autonomously before asking user",
        retrievalHints: {
          technologies: ["typescript"],
          changeTypes: ["implementation"],
        },
      }),
    });
    expect(createResponse.status).toBe(200);
    const createJson = (await createResponse.json()) as { decisionId: string; confidence: number };
    expect(createJson.decisionId).toBeTruthy();
    expect(createJson.confidence).toBeGreaterThan(0);

    const detailResponse = await app.request(`/api/context-decisions/${createJson.decisionId}`);
    expect(detailResponse.status).toBe(200);
    const detailJson = (await detailResponse.json()) as {
      detail: { evidence: unknown[]; coverage: unknown[] };
    };
    expect(detailJson.detail.evidence.length).toBeGreaterThan(0);
    expect(detailJson.detail.coverage.length).toBeGreaterThan(0);

    const feedbackResponse = await app.request(
      `/api/context-decisions/${createJson.decisionId}/human-feedback`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: "good" }),
      },
    );
    expect(feedbackResponse.status).toBe(200);
    const feedbackJson = (await feedbackResponse.json()) as {
      detail: { run: { humanFeedback: string | null }; effects: unknown[] } | null;
    };
    expect(feedbackJson.detail?.run.humanFeedback).toBe("good");
    expect(feedbackJson.detail?.effects.length).toBeGreaterThan(0);
  }, 15000);

  test("POST /api/vibe-memory persists memory and GET /api/vibe-memory lists it", async () => {
    const createResponse = await app.request("/api/vibe-memory", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "integration-session-newer",
        content: "integration vibe memory newer token",
        metadata: {
          timestamp: "2026-05-21T10:00:00.000Z",
          sourceId: "codex_logs",
        },
      }),
    });
    expect(createResponse.status).toBe(201);

    const createOlderResponse = await app.request("/api/vibe-memory", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "integration-session-older",
        content: "integration vibe memory older token",
        metadata: {
          timestamp: "2026-05-18T10:00:00.000Z",
          sourceId: "codex_logs",
        },
      }),
    });
    expect(createOlderResponse.status).toBe(201);

    await db.insert(vibeMemories).values({
      sessionId: "goal:integration-goal-list-hidden",
      content: "capsule should not appear in raw vibe sessions",
      memoryType: "capsule",
    });

    const listResponse = await app.request("/api/vibe-memory?limit=10");
    expect(listResponse.status).toBe(200);
    const json = (await listResponse.json()) as {
      memories: Array<{ sessionId: string; content: string; memoryType: string }>;
    };
    expect(json.memories[0]?.sessionId).toBe("integration-session-newer");
    expect(
      json.memories.some(
        (memory) =>
          memory.sessionId === "integration-session-newer" &&
          memory.content.includes("integration vibe memory newer token"),
      ),
    ).toBe(true);
    expect(
      json.memories.some(
        (memory) =>
          memory.sessionId === "integration-session-older" &&
          memory.content.includes("integration vibe memory older token"),
      ),
    ).toBe(true);
    expect(json.memories.some((memory) => memory.memoryType === "capsule")).toBe(false);
    expect(
      json.memories.some((memory) =>
        memory.content.includes("capsule should not appear in raw vibe sessions"),
      ),
    ).toBe(false);
  });

  test("POST /api/session-memo/item and GET /api/session-memo work with session-scoped slots", async () => {
    const createResponse = await app.request("/api/session-memo/item", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "integration-session-memo",
        label: "goal",
        body: "finish session memo integration test",
        metadata: { score: 92 },
      }),
    });
    expect(createResponse.status).toBe(201);

    const listResponse = await app.request(
      "/api/session-memo?sessionId=integration-session-memo&includeEmpty=true",
    );
    expect(listResponse.status).toBe(200);
    const listJson = (await listResponse.json()) as {
      items: Array<{ slot: number; label?: string; preview?: string; empty?: boolean }>;
      events: Array<{ action: string }>;
    };
    expect(listJson.items).toHaveLength(40);
    expect(
      listJson.items.some(
        (item) => item.label === "goal" && item.preview === "finish session memo integration test",
      ),
    ).toBe(true);
    expect(listJson.events.some((event) => event.action === "put")).toBe(true);

    const getResponse = await app.request(
      "/api/session-memo/item?sessionId=integration-session-memo&label=goal",
    );
    expect(getResponse.status).toBe(200);
    const getJson = (await getResponse.json()) as { memo: { body: string; slot: number } };
    expect(Number.isInteger(getJson.memo.slot)).toBe(true);
    expect(getJson.memo.slot).toBeGreaterThanOrEqual(0);
    expect(getJson.memo.body).toBe("finish session memo integration test");
  });

  test("GET /api/session-memo/item returns 400 when neither slot nor label is provided", async () => {
    const response = await app.request("/api/session-memo/item?sessionId=integration-session-memo");
    expect(response.status).toBe(400);
  });

  test("POST /api/session-memo/item rejects compile_eval kind", async () => {
    const response = await app.request("/api/session-memo/item", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "integration-session-compile-eval",
        kind: "compile_eval",
        body: "first evaluation",
      }),
    });
    expect(response.status).toBe(400);
  });

  test("POST /api/session-memo/item keeps next empty slot behavior for non-compile-eval notes", async () => {
    const sessionId = `integration-session-slot-guard-${Date.now()}`;
    const compileResponse = await app.request("/api/context/compile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goal: "integration compile_result slot guard token",
      }),
    });
    expect(compileResponse.status).toBe(200);
    const compileJson = (await compileResponse.json()) as { pack: { runId: string } };

    const createCompileResult = await app.request("/api/session-memo/item", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId,
        kind: "compile_result",
        body: "context_compile output reference",
        metadata: { contextCompileRunId: compileJson.pack.runId },
      }),
    });
    expect(createCompileResult.status).toBe(201);
    const compileResultJson = (await createCompileResult.json()) as { memo: { slot: number } };
    expect(compileResultJson.memo.slot).toBe(0);

    const createScratch = await app.request("/api/session-memo/item", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId,
        kind: "scratch",
        title: "memo",
        body: "note",
      }),
    });
    expect(createScratch.status).toBe(201);
    const memoJson = (await createScratch.json()) as { memo: { slot: number; kind: string } };
    expect(memoJson.memo.kind).toBe("scratch");
    expect(memoJson.memo.slot).toBe(1);
  });

  test("GET /api/session-memo exposes linkedGoal and linkedOutput for compile-linked notes", async () => {
    const sessionId = `integration-session-compile-result-${Date.now()}`;
    const compileResponse = await app.request("/api/context/compile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goal: "integration compile_result linked output token",
      }),
    });
    expect(compileResponse.status).toBe(200);
    const compileJson = (await compileResponse.json()) as {
      pack: { runId: string };
      markdown: string;
    };
    const runId = compileJson.pack.runId;

    const createResponse = await app.request("/api/session-memo/item", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId,
        kind: "compile_result",
        body: "context_compile output reference",
        metadata: { contextCompileRunId: runId },
      }),
    });
    expect(createResponse.status).toBe(201);
    const createJson = (await createResponse.json()) as { memo: { slot: number } };

    const getResponse = await app.request(
      `/api/session-memo/item?sessionId=${encodeURIComponent(sessionId)}&slot=${createJson.memo.slot}`,
    );
    expect(getResponse.status).toBe(200);
    const getJson = (await getResponse.json()) as {
      memo: {
        linkedGoal: string | null;
        linkedOutputMarkdown: string | null;
        linkedOutputAvailable: boolean;
        contextCompileRunId: string | null;
      };
    };
    expect(getJson.memo.contextCompileRunId).toBe(runId);
    expect(getJson.memo.linkedGoal).toBe("integration compile_result linked output token");
    expect(getJson.memo.linkedOutputAvailable).toBe(true);
    expect(getJson.memo.linkedOutputMarkdown).toBe(compileJson.markdown);

    const listResponse = await app.request(
      `/api/session-memo?sessionId=${encodeURIComponent(sessionId)}`,
    );
    expect(listResponse.status).toBe(200);
    const listJson = (await listResponse.json()) as {
      items: Array<{
        kind?: string;
        label?: string | null;
        linkedGoal?: string | null;
        linkedOutputMarkdown?: string | null;
      }>;
    };
    const resultItem = listJson.items.find((item) => item.label === `compile_result:${runId}`);
    expect(resultItem?.linkedGoal).toBe("integration compile_result linked output token");
    expect(resultItem?.linkedOutputMarkdown).toBe(compileJson.markdown);
  });

  test("GET /api/session-memo/sessions excludes compile_result-only sessions by default", async () => {
    const compileOnlyResponse = await app.request("/api/session-memo/item", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "integration-session-compile-only",
        kind: "compile_result",
        body: "context_compile output reference",
        metadata: { contextCompileRunId: "run-compile-only" },
      }),
    });
    expect(compileOnlyResponse.status).toBe(201);

    const normalResponse = await app.request("/api/session-memo/item", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "integration-session-regular",
        kind: "scratch",
        body: "manual note",
      }),
    });
    expect(normalResponse.status).toBe(201);

    const defaultList = await app.request("/api/session-memo/sessions?limit=20");
    expect(defaultList.status).toBe(200);
    const defaultJson = (await defaultList.json()) as {
      items: Array<{ sessionId: string }>;
    };
    expect(defaultJson.items.some((item) => item.sessionId === "integration-session-regular")).toBe(
      true,
    );
    expect(
      defaultJson.items.some((item) => item.sessionId === "integration-session-compile-only"),
    ).toBe(false);

    const includeCompileOnlyList = await app.request(
      "/api/session-memo/sessions?limit=20&includeCompileOnly=true",
    );
    expect(includeCompileOnlyList.status).toBe(200);
    const includeCompileOnlyJson = (await includeCompileOnlyList.json()) as {
      items: Array<{ sessionId: string }>;
    };
    expect(
      includeCompileOnlyJson.items.some(
        (item) => item.sessionId === "integration-session-compile-only",
      ),
    ).toBe(true);
  });

  test("GET /api/session-memo/sessions returns a real timestamp and newest sessions first", async () => {
    const olderSessionId = `integration-session-older-${Date.now()}`;
    const newerSessionId = `integration-session-newer-${Date.now() + 1}`;

    const olderResponse = await app.request("/api/session-memo/item", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: olderSessionId,
        kind: "scratch",
        body: "older memo",
      }),
    });
    expect(olderResponse.status).toBe(201);

    await new Promise((resolve) => setTimeout(resolve, 25));

    const newerResponse = await app.request("/api/session-memo/item", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: newerSessionId,
        kind: "scratch",
        body: "newer memo",
      }),
    });
    expect(newerResponse.status).toBe(201);

    const listResponse = await app.request(
      "/api/session-memo/sessions?limit=20&includeCompileOnly=true",
    );
    expect(listResponse.status).toBe(200);
    const listJson = (await listResponse.json()) as {
      items: Array<{ sessionId: string; lastUpdatedAt: string }>;
    };

    const newerItem = listJson.items.find((item) => item.sessionId === newerSessionId);
    const olderItem = listJson.items.find((item) => item.sessionId === olderSessionId);
    expect(newerItem).toBeDefined();
    expect(olderItem).toBeDefined();
    if (!newerItem || !olderItem) {
      throw new Error("expected both session memo rows to exist");
    }
    expect(newerItem?.lastUpdatedAt).not.toBe("1970-01-01T00:00:00.000Z");
    expect(olderItem?.lastUpdatedAt).not.toBe("1970-01-01T00:00:00.000Z");
    expect(new Date(newerItem.lastUpdatedAt).getTime()).toBeGreaterThan(
      new Date(olderItem.lastUpdatedAt).getTime(),
    );
    expect(listJson.items[0]?.sessionId).toBe(newerSessionId);
    expect(listJson.items[1]?.sessionId).toBe(olderSessionId);
  });

  test("GET /api/session-memo/sessions lastUpdatedAt matches latest memo updatedAt in the same session", async () => {
    const sessionId = `integration-session-time-sync-${Date.now()}`;

    const createResponse = await app.request("/api/session-memo/item", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId,
        kind: "scratch",
        body: "timezone alignment check",
      }),
    });
    expect(createResponse.status).toBe(201);

    const memosResponse = await app.request(
      `/api/session-memo?sessionId=${encodeURIComponent(sessionId)}`,
    );
    expect(memosResponse.status).toBe(200);
    const memosJson = (await memosResponse.json()) as {
      items: Array<{ updatedAt?: string }>;
    };
    const latestMemoUpdatedAt = memosJson.items
      .map((item) => item.updatedAt)
      .filter((value): value is string => typeof value === "string")
      .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0];
    expect(latestMemoUpdatedAt).toBeDefined();
    if (!latestMemoUpdatedAt) {
      throw new Error("expected latest memo updatedAt");
    }

    const sessionsResponse = await app.request(
      "/api/session-memo/sessions?limit=50&includeCompileOnly=true",
    );
    expect(sessionsResponse.status).toBe(200);
    const sessionsJson = (await sessionsResponse.json()) as {
      items: Array<{ sessionId: string; lastUpdatedAt: string }>;
    };
    const sessionRow = sessionsJson.items.find((item) => item.sessionId === sessionId);
    expect(sessionRow).toBeDefined();
    if (!sessionRow) {
      throw new Error("expected session row");
    }

    expect(sessionRow.lastUpdatedAt).toBe(latestMemoUpdatedAt);
  });
});
