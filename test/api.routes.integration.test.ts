import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import app from "../api/app.js";
import { upsertKnowledgeFromSource } from "../src/modules/knowledge/knowledge.repository.js";
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
  });

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

  test("POST /api/vibe-memory persists memory and GET /api/vibe-memory lists it", async () => {
    const createResponse = await app.request("/api/vibe-memory", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: "integration-session",
        content: "integration vibe memory token",
      }),
    });
    expect(createResponse.status).toBe(201);

    const listResponse = await app.request("/api/vibe-memory?limit=10");
    expect(listResponse.status).toBe(200);
    const json = (await listResponse.json()) as {
      memories: Array<{ sessionId: string; content: string }>;
    };
    expect(
      json.memories.some(
        (memory) =>
          memory.sessionId === "integration-session" &&
          memory.content.includes("integration vibe memory token"),
      ),
    ).toBe(true);
  });
});
