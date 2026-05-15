import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { config } from "../src/config.js";
import { getDb } from "../src/db/index.js";
import { knowledgeItems, knowledgeSourceLinks, sourceDistillationRuns } from "../src/db/schema.js";
import { distillSources } from "../src/modules/sources/distillation.service.js";
import { upsertSourceDocument } from "../src/modules/sources/source.repository.js";
import {
  closeIntegrationDb,
  ensureDbIntegrationReady,
  isDbIntegrationEnabled,
  truncateIntegrationTables,
} from "./helpers/integration.js";

const describeDb = isDbIntegrationEnabled() ? describe : describe.skip;

function testEmbedding(): number[] {
  return Array.from({ length: config.embeddingDimension }, (_, index) => (index === 0 ? 1 : 0));
}

describeDb("source distillation integration", () => {
  beforeAll(async () => {
    await ensureDbIntegrationReady();
  });

  beforeEach(async () => {
    await truncateIntegrationTables();
  });

  afterAll(async () => {
    await closeIntegrationDb();
  });

  test("distills source fragment into embedded draft knowledge and source link", async () => {
    await upsertSourceDocument({
      sourceKind: "wiki",
      uri: "/tmp/wiki/verify.md",
      title: "Verify",
      contentHash: "source-hash-verify",
      body: "# Verify\nRun the repository verify command before committing implementation work.",
    });

    const summary = await distillSources({
      apply: true,
      limit: 5,
      modelClient: async () =>
        JSON.stringify({
          candidates: [
            {
              type: "procedure",
              title: "Run verify before commit",
              body: "Before committing implementation work, run the repository verify command and fix failures first.",
              confidence: 0.9,
              importance: 0.9,
              score: 0.95,
              sourceRefs: ["source:/tmp/wiki/verify.md#chunk:0001"],
            },
          ],
        }),
      embedder: async () => testEmbedding(),
    });

    expect(summary.ok).toBe(true);
    expect(summary.processed).toBe(1);
    expect(summary.knowledgeCount).toBe(1);

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
      title: "Run verify before commit",
      embedded: true,
    });
    expect(knowledgeRows[0]?.metadata).toMatchObject({
      source: "source_distillation",
      sourceKind: "wiki",
      sourceDocumentUri: "/tmp/wiki/verify.md",
    });

    const runRows = await db.select().from(sourceDistillationRuns);
    expect(runRows).toHaveLength(1);
    expect(runRows[0]?.status).toBe("ok");
    expect(runRows[0]?.candidateCount).toBe(1);
    expect(runRows[0]?.knowledgeIds).toEqual([knowledgeRows[0]?.id]);

    const linkRows = await db
      .select()
      .from(knowledgeSourceLinks)
      .where(eq(knowledgeSourceLinks.knowledgeId, knowledgeRows[0]?.id ?? ""));
    expect(linkRows).toHaveLength(1);
  });
});
