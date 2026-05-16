import { beforeAll, beforeEach, describe, expect, test, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import { groupedConfig } from "../src/config.js";
import { getDb } from "../src/db/index.js";
import {
  distillationCandidates,
  knowledgeItems,
  vibeMemoryDistillationRuns,
} from "../src/db/schema.js";
import { distillVibeMemories } from "../src/modules/vibe-memory/distillation.service.js";
import { recordVibeMemoryWithDiffEntries } from "../src/modules/vibe-memory/vibe-memory.service.js";
import {
  closeIntegrationDb,
  ensureDbIntegrationReady,
  isDbIntegrationEnabled,
  truncateIntegrationTables,
} from "./helpers/integration.js";

const describeDb = isDbIntegrationEnabled() ? describe : describe.skip;

function testEmbedding(): number[] {
  return Array.from({ length: groupedConfig.embedding.dimension }, (_, index) =>
    index === 0 ? 1 : 0,
  );
}

function searchToolEvent() {
  return {
    callId: "search-1",
    name: "search_web",
    ok: true,
    content: "Search evidence",
  };
}

describeDb("vibe memory distillation integration", () => {
  beforeAll(async () => {
    await ensureDbIntegrationReady();
  });

  beforeEach(async () => {
    await truncateIntegrationTables();
  });

  afterAll(async () => {
    await closeIntegrationDb();
  });

  test("distills vibe memory into embedded draft knowledge and records the run", async () => {
    const recorded = await recordVibeMemoryWithDiffEntries({
      sessionId: "distill-session",
      content: "When generating knowledge from conversation logs, keep the result draft first.",
      memoryType: "chat",
      diff: `diff --git a/src/example.ts b/src/example.ts
--- a/src/example.ts
+++ b/src/example.ts
@@ -1 +1 @@
-old
+new
`,
    });
    let modelCalls = 0;

    const summary = await distillVibeMemories({
      apply: true,
      limit: 5,
      modelClient: async (_request, options) => {
        modelCalls += 1;
        const content = JSON.stringify({
          candidates: [
            {
              type: "procedure",
              title: "Review distilled knowledge before activation",
              body: "When vibe memory is distilled into knowledge, save it as draft and activate it only after review.",
              confidence: 82,
              importance: 74,
              score: 0.86,
              sourceRefs: ["vibe-memory:distill-session"],
            },
          ],
        });
        if (options?.enableTools === false) return content;
        return {
          content,
          toolEvents: [searchToolEvent()],
          messages: [],
        };
      },
      embedder: async () => testEmbedding(),
    });

    expect(summary.ok).toBe(true);
    expect(summary.processed).toBe(1);
    expect(summary.knowledgeCount).toBe(1);
    expect(modelCalls).toBe(2);

    const db = getDb();
    const knowledgeRows = await db
      .select({
        id: knowledgeItems.id,
        type: knowledgeItems.type,
        status: knowledgeItems.status,
        title: knowledgeItems.title,
        metadata: knowledgeItems.metadata,
        embedded: sql<boolean>`${knowledgeItems.embedding} is not null`,
      })
      .from(knowledgeItems);

    expect(knowledgeRows).toHaveLength(1);
    expect(knowledgeRows[0]).toMatchObject({
      type: "procedure",
      status: "draft",
      title: "Review distilled knowledge before activation",
      embedded: true,
    });
    expect(knowledgeRows[0]?.metadata).toMatchObject({
      source: "vibe_memory_distillation",
      sourceKind: "vibe_memory",
      sourceVibeMemoryIds: [recorded.memory.id],
      sourceSessionId: "distill-session",
    });

    const runRows = await db
      .select()
      .from(vibeMemoryDistillationRuns)
      .where(eq(vibeMemoryDistillationRuns.vibeMemoryId, recorded.memory.id));

    expect(runRows).toHaveLength(1);
    expect(runRows[0]?.status).toBe("ok");
    expect(runRows[0]?.candidateCount).toBe(1);
    expect(runRows[0]?.knowledgeIds).toEqual([knowledgeRows[0]?.id]);

    const candidateRows = await db.select().from(distillationCandidates);
    expect(candidateRows).toHaveLength(1);
    expect(candidateRows[0]).toMatchObject({
      sourceKind: "vibe_memory",
      vibeMemoryId: recorded.memory.id,
      vibeMemoryRunId: runRows[0]?.id,
      status: "promoted",
      knowledgeId: knowledgeRows[0]?.id,
    });
    expect(candidateRows[0]?.toolEvents).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "search_web", ok: true })]),
    );

    const secondSummary = await distillVibeMemories({
      apply: true,
      limit: 5,
      modelClient: async () => {
        modelCalls += 1;
        return JSON.stringify({ candidates: [] });
      },
      embedder: async () => testEmbedding(),
    });

    expect(secondSummary.processed).toBe(0);
    expect(modelCalls).toBe(2);
  });
});
