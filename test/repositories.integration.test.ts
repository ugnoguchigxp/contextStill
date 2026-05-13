import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  getCompileRunSnapshot,
  insertCompileRun,
  insertContextPackItems,
  listRecentCompileRuns,
} from "../src/modules/context-compiler/context-compiler.repository.js";
import {
  insertEvidenceFragment,
  searchEvidence,
  upsertEvidenceSource,
} from "../src/modules/evidence/evidence.repository.js";
import {
  searchKnowledge,
  upsertKnowledgeFromSource,
} from "../src/modules/knowledge/knowledge.repository.js";
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
      body: "Always keep evidence refs attached to factual claims.",
    });

    const draftId = await upsertKnowledgeFromSource({
      sourceUri: "file:///draft.md",
      contentHash: "hash-draft",
      type: "skill",
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
      statuses: ["active", "trial", "draft"],
    });
    expect(withDrafts.some((item) => item.id === activeId)).toBe(true);
    expect(withDrafts.some((item) => item.id === draftId)).toBe(true);
  });

  test("evidence source/fragment upsert and search works", async () => {
    const sourceId = await upsertEvidenceSource({
      sourceKind: "markdown",
      uri: "file:///docs/evidence.md",
      title: "Evidence",
      contentHash: "evidence-hash-1",
    });
    await insertEvidenceFragment({
      sourceId,
      locator: "line:1-5",
      content: "compile command failed because vector extension was missing.",
    });

    const hits = await searchEvidence("vector extension", 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.sourceId).toBe(sourceId);
    expect(hits[0]?.sourceUri).toBe("file:///docs/evidence.md");
  });

  test("compile run and context pack items are persisted and retrievable", async () => {
    const runId = await insertCompileRun({
      goal: "integration run",
      intent: "review",
      input: { goal: "integration run", intent: "review" },
      retrievalMode: "review_context",
      status: "degraded",
      degradedReasons: ["NO_EVIDENCE_MATCH"],
      tokenBudget: 2048,
    });

    await insertContextPackItems(runId, [
      {
        itemKind: "rule",
        itemId: "rule-1",
        section: "rules",
        score: 0.9,
        rankingReason: "integration test",
        evidenceRefs: ["file:///docs/evidence.md#line:1-5"],
      },
      {
        itemKind: "skill",
        itemId: "skill-1",
        section: "skills",
        score: 0.8,
        rankingReason: "integration test",
        evidenceRefs: [],
      },
    ]);

    const runs = await listRecentCompileRuns(5);
    expect(runs[0]?.id).toBe(runId);
    expect(runs[0]?.status).toBe("degraded");

    const snapshot = await getCompileRunSnapshot(runId);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.items.length).toBe(2);
    expect(snapshot?.items[0]?.section).toBe("rules");
    expect(snapshot?.items[0]?.evidenceRefs.length).toBeGreaterThan(0);
  });
});
