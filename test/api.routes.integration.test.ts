import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import app from "../api/app.js";
import { upsertKnowledgeFromSource } from "../src/modules/knowledge/knowledge.repository.js";
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

  test("POST /api/context/compile returns context-pack shape", async () => {
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
    const json = (await response.json()) as { pack: unknown };
    const parsed = contextPackSchema.parse(json.pack);
    expect(parsed.goal).toBe("integration compile token");
    expect(parsed.retrievalMode).toBe("task_context");
  });

  test("GET /api/knowledge returns persisted items", async () => {
    await upsertKnowledgeFromSource({
      sourceUri: "file:///integration/knowledge.md",
      contentHash: "integration-knowledge-hash",
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
    const json = (await response.json()) as { items: Array<{ title: string }> };
    expect(json.items.some((item) => item.title === "Integration Knowledge Rule")).toBe(true);
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
