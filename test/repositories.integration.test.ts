import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  getCompileRunSnapshot,
  insertCompileRun,
  insertContextPackItems,
  listRecentCompileRuns,
} from "../src/modules/context-compiler/context-compiler.repository.js";
import {
  searchKnowledge,
  upsertKnowledgeFromSource,
} from "../src/modules/knowledge/knowledge.repository.js";
import {
  searchSourceContent,
  upsertSourceDocument,
} from "../src/modules/sources/source.repository.js";
import {
  recordVibeMemoryWithDiffEntries,
  retrieveVibeMemoryContext,
} from "../src/modules/vibe-memory/vibe-memory.service.js";
import {
  closeIntegrationDb,
  ensureDbIntegrationReady,
  isDbIntegrationEnabled,
  truncateIntegrationTables,
} from "./helpers/integration.js";

const describeDb = isDbIntegrationEnabled() ? describe : describe.skip;

describeDb("repositories integration", () => {
  beforeAll(async () => {
    await ensureDbIntegrationReady();
  });

  beforeEach(async () => {
    await truncateIntegrationTables();
  });

  afterAll(async () => {
    await closeIntegrationDb();
  });

  test("knowledge upsert/search respects lifecycle filters", async () => {
    const activeId = await upsertKnowledgeFromSource({
      sourceUri: "file:///active.md",
      contentHash: "hash-active",
      type: "rule",
      status: "active",
      scope: "repo",
      title: "Repository Integration Rule",
      body: "Always keep source refs attached to factual claims.",
    });

    const draftId = await upsertKnowledgeFromSource({
      sourceUri: "file:///draft.md",
      contentHash: "hash-draft",
      type: "procedure",
      status: "draft",
      scope: "repo",
      title: "Repository Integration Skill",
      body: "Use runbook command sequence for integration checks.",
    });

    const activeOnly = await searchKnowledge({
      query: "integration",
      limit: 10,
      status: "active",
      statuses: ["active"],
    });
    expect(activeOnly.some((item) => item.id === activeId)).toBe(true);
    expect(activeOnly.some((item) => item.id === draftId)).toBe(false);

    const withDrafts = await searchKnowledge({
      query: "integration",
      limit: 10,
      status: "active",
      statuses: ["active", "draft"],
    });
    expect(withDrafts.some((item) => item.id === activeId)).toBe(true);
    expect(withDrafts.some((item) => item.id === draftId)).toBe(true);
  });

  test("source document upsert creates searchable source content", async () => {
    const sourceId = await upsertSourceDocument({
      sourceKind: "wiki",
      uri: "file:///docs/source.md",
      title: "Source",
      contentHash: "source-hash-1",
      body: "compile command failed because vector extension was missing.",
      metadata: { tags: ["vector-runtime", "operations"] },
    });

    const hits = await searchSourceContent("vector extension", 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.sourceId).toBe(sourceId);
    expect(hits[0]?.sourceUri).toBe("file:///docs/source.md");

    const tagHits = await searchSourceContent("vector-runtime", 5);
    expect(tagHits.some((hit) => hit.sourceId === sourceId)).toBe(true);
  });

  test("compile run and context pack items are persisted and retrievable", async () => {
    const runId = await insertCompileRun({
      goal: "integration run",
      intent: "review",
      input: { goal: "integration run", intent: "review" },
      retrievalMode: "review_context",
      status: "degraded",
      degradedReasons: ["NO_SOURCE_MATCH"],
      tokenBudget: 2048,
    });

    await insertContextPackItems(runId, [
      {
        itemKind: "rule",
        itemId: "rule-1",
        section: "rules",
        score: 0.9,
        rankingReason: "integration test",
        sourceRefs: ["file:///docs/source.md#line:1-5"],
      },
      {
        itemKind: "procedure",
        itemId: "procedure-1",
        section: "procedures",
        score: 0.8,
        rankingReason: "integration test",
        sourceRefs: [],
      },
    ]);

    const runs = await listRecentCompileRuns(5);
    expect(runs[0]?.id).toBe(runId);
    expect(runs[0]?.status).toBe("degraded");

    const snapshot = await getCompileRunSnapshot(runId);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.items.length).toBe(2);
    expect(snapshot?.items[0]?.section).toBe("rules");
    expect(snapshot?.items[0]?.sourceRefs.length).toBeGreaterThan(0);
  });

  test("vibe memory recording persists agent diffs and extracted symbols", async () => {
    const result = await recordVibeMemoryWithDiffEntries({
      sessionId: "integration-agent-diff-session",
      content: "AI generated repository diff",
      memoryType: "action",
      diff: `diff --git a/src/integration.ts b/src/integration.ts
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/src/integration.ts
@@ -0,0 +1,5 @@
+export function integrationValue(): number {
+  return 7;
+}
+
+export const integrationName = "memory-router";
`,
    });

    expect(result.memory.sessionId).toBe("integration-agent-diff-session");
    expect(result.diffEntries.length).toBeGreaterThan(0);
    expect(result.diffEntries[0]?.vibeMemoryId).toBe(result.memory.id);
    expect(result.diffEntries[0]?.filePath).toBe("src/integration.ts");
    expect(result.diffEntries.some((entry) => entry.symbolName === "integrationValue")).toBe(true);
    expect(result.diffEntries.some((entry) => entry.startLine === 1)).toBe(true);

    const hits = await retrieveVibeMemoryContext({
      query: "integrationValue",
      sessionId: "integration-agent-diff-session",
      limit: 5,
    });
    expect(hits.some((hit) => hit.id === result.memory.id)).toBe(true);
  });
});
