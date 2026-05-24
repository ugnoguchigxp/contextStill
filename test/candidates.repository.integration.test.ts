import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { listCandidateItems } from "../api/modules/candidates/candidates.repository.js";
import { db } from "../src/db/index.js";
import {
  coverEvidenceResults,
  distillationTargetStates,
  findCandidateResults,
  knowledgeItems,
} from "../src/db/schema.js";
import {
  closeIntegrationDb,
  ensureDbIntegrationReady,
  isDbIntegrationEnabled,
  truncateIntegrationTables,
} from "./helpers/integration.js";

const describeDb = isDbIntegrationEnabled() ? describe : describe.skip;

function iso(value: string): Date {
  return new Date(value);
}

describeDb("candidates repository integration", () => {
  beforeAll(async () => {
    await ensureDbIntegrationReady();
  });

  beforeEach(async () => {
    await truncateIntegrationTables();
  });

  afterAll(async () => {
    await closeIntegrationDb();
  });

  test("computes outcomes and joins knowledge metadata keys", async () => {
    await db.insert(distillationTargetStates).values([
      {
        id: "00000000-0000-0000-0000-000000000001",
        targetKind: "wiki_file",
        targetKey: "target-1",
        sourceUri: "file:///workspace/wiki/target-1.md",
        distillationVersion: "v1",
        status: "running",
        phase: "covering_evidence",
        priorityGroup: "wiki",
        sortKey: "target-1",
        updatedAt: iso("2026-05-20T00:01:00.000Z"),
      },
      {
        id: "00000000-0000-0000-0000-000000000002",
        targetKind: "wiki_file",
        targetKey: "target-2",
        sourceUri: "file:///workspace/wiki/target-2.md",
        distillationVersion: "v1",
        status: "completed",
        phase: "stored",
        priorityGroup: "wiki",
        sortKey: "target-2",
        updatedAt: iso("2026-05-20T00:02:00.000Z"),
      },
      {
        id: "00000000-0000-0000-0000-000000000003",
        targetKind: "wiki_file",
        targetKey: "target-3",
        sourceUri: "file:///workspace/wiki/target-3.md",
        distillationVersion: "v1",
        status: "completed",
        phase: "finalizing",
        priorityGroup: "wiki",
        sortKey: "target-3",
        updatedAt: iso("2026-05-20T00:03:00.000Z"),
      },
      {
        id: "00000000-0000-0000-0000-000000000004",
        targetKind: "wiki_file",
        targetKey: "target-4",
        sourceUri: "file:///workspace/wiki/target-4.md",
        distillationVersion: "v1",
        status: "completed",
        phase: "finalizing",
        priorityGroup: "wiki",
        sortKey: "target-4",
        updatedAt: iso("2026-05-20T00:04:00.000Z"),
      },
      {
        id: "00000000-0000-0000-0000-000000000005",
        targetKind: "wiki_file",
        targetKey: "target-5",
        sourceUri: "file:///workspace/wiki/target-5.md",
        distillationVersion: "v1",
        status: "completed",
        phase: "finalizing",
        priorityGroup: "wiki",
        sortKey: "target-5",
        updatedAt: iso("2026-05-20T00:05:00.000Z"),
      },
      {
        id: "00000000-0000-0000-0000-000000000006",
        targetKind: "wiki_file",
        targetKey: "target-6",
        sourceUri: "file:///workspace/wiki/target-6.md",
        distillationVersion: "v1",
        status: "completed",
        phase: "stored",
        priorityGroup: "wiki",
        sortKey: "target-6",
        updatedAt: iso("2026-05-20T00:06:00.000Z"),
      },
      {
        id: "00000000-0000-0000-0000-000000000007",
        targetKind: "wiki_file",
        targetKey: "target-7",
        sourceUri: "file:///workspace/wiki/target-7.md",
        distillationVersion: "v1",
        status: "completed",
        phase: "stored",
        priorityGroup: "wiki",
        sortKey: "target-7",
        updatedAt: iso("2026-05-20T00:07:00.000Z"),
      },
      {
        id: "00000000-0000-0000-0000-000000000008",
        targetKind: "knowledge_candidate",
        targetKey: "target-8",
        sourceUri: "agent://candidate/target-8",
        distillationVersion: "v1",
        status: "pending",
        phase: "selected",
        priorityGroup: "knowledge_candidate",
        sortKey: "target-8",
        updatedAt: iso("2026-05-20T00:08:20.000Z"),
      },
    ]);

    await db.insert(findCandidateResults).values([
      {
        id: "10000000-0000-0000-0000-000000000001",
        targetStateId: "00000000-0000-0000-0000-000000000001",
        candidateIndex: 0,
        title: "Candidate 1",
        content: "Body 1",
        status: "selected",
        updatedAt: iso("2026-05-20T00:01:10.000Z"),
      },
      {
        id: "10000000-0000-0000-0000-000000000002",
        targetStateId: "00000000-0000-0000-0000-000000000002",
        candidateIndex: 0,
        title: "Candidate 2",
        content: "Body 2",
        status: "selected",
        updatedAt: iso("2026-05-20T00:02:10.000Z"),
      },
      {
        id: "10000000-0000-0000-0000-000000000003",
        targetStateId: "00000000-0000-0000-0000-000000000003",
        candidateIndex: 0,
        title: "Candidate 3",
        content: "Body 3",
        status: "selected",
        updatedAt: iso("2026-05-20T00:03:10.000Z"),
      },
      {
        id: "10000000-0000-0000-0000-000000000004",
        targetStateId: "00000000-0000-0000-0000-000000000004",
        candidateIndex: 0,
        title: "Candidate 4",
        content: "Body 4",
        status: "selected",
        updatedAt: iso("2026-05-20T00:04:10.000Z"),
      },
      {
        id: "10000000-0000-0000-0000-000000000005",
        targetStateId: "00000000-0000-0000-0000-000000000005",
        candidateIndex: 0,
        title: "Candidate 5",
        content: "Body 5",
        status: "selected",
        updatedAt: iso("2026-05-20T00:05:10.000Z"),
      },
      {
        id: "10000000-0000-0000-0000-000000000006",
        targetStateId: "00000000-0000-0000-0000-000000000006",
        candidateIndex: 0,
        title: "Candidate 6",
        content: "Body 6",
        status: "selected",
        updatedAt: iso("2026-05-20T00:06:10.000Z"),
      },
      {
        id: "10000000-0000-0000-0000-000000000007",
        targetStateId: "00000000-0000-0000-0000-000000000007",
        candidateIndex: 0,
        title: "Candidate 7",
        content: "Body 7",
        status: "selected",
        updatedAt: iso("2026-05-20T00:07:10.000Z"),
      },
      {
        id: "10000000-0000-0000-0000-000000000008",
        targetStateId: "00000000-0000-0000-0000-000000000008",
        candidateIndex: 0,
        title: "Candidate 8",
        content: "Body 8",
        status: "selected",
        updatedAt: iso("2026-05-20T00:01:00.000Z"),
      },
    ]);

    await db.insert(coverEvidenceResults).values([
      {
        id: "10000000-0000-0000-0000-000000000003",
        status: "knowledge_ready",
        stage: "final",
        type: "rule",
        title: "Covered 3",
        body: "Covered body 3",
        importance: 78,
        confidence: 66,
      },
      {
        id: "10000000-0000-0000-0000-000000000004",
        status: "duplicate",
        stage: "dedupe",
        reason: "duplicate_match",
      },
      {
        id: "10000000-0000-0000-0000-000000000005",
        status: "tool_failed",
        stage: "web",
        reason: "search_timeout",
      },
      {
        id: "10000000-0000-0000-0000-000000000006",
        status: "knowledge_ready",
        stage: "final",
        type: "rule",
        title: "Covered 6",
        body: "Covered body 6",
        importance: 80,
        confidence: 74,
      },
      {
        id: "10000000-0000-0000-0000-000000000007",
        status: "knowledge_ready",
        stage: "final",
        type: "procedure",
        title: "Covered 7",
        body: "Covered body 7",
        importance: 82,
        confidence: 72,
      },
      {
        id: "10000000-0000-0000-0000-000000000008",
        status: "reprocess_requested",
        stage: "final",
        reason: "reprocess_requested:procedure_body_not_actionable",
        updatedAt: iso("2026-05-20T00:08:30.000Z"),
      },
    ]);

    await db.insert(knowledgeItems).values([
      {
        id: "20000000-0000-0000-0000-000000000061",
        type: "rule",
        status: "draft",
        scope: "repo",
        title: "Knowledge older 6",
        body: "Knowledge body older 6",
        confidence: 70,
        importance: 70,
        metadata: {
          coverEvidenceResultId: "10000000-0000-0000-0000-000000000006",
          sourceUri: "cover-evidence-result://10000000-0000-0000-0000-000000000006",
        },
        updatedAt: iso("2026-05-20T00:06:20.000Z"),
      },
      {
        id: "20000000-0000-0000-0000-000000000062",
        type: "rule",
        status: "active",
        scope: "repo",
        title: "Knowledge latest 6",
        body: "Knowledge body latest 6",
        confidence: 71,
        importance: 75,
        metadata: {
          coverEvidenceResultId: "10000000-0000-0000-0000-000000000006",
          sourceUri: "cover-evidence-result://10000000-0000-0000-0000-000000000006",
        },
        updatedAt: iso("2026-05-20T00:06:30.000Z"),
      },
      {
        id: "20000000-0000-0000-0000-000000000071",
        type: "procedure",
        status: "draft",
        scope: "repo",
        title: "Knowledge via sourceUri 7",
        body: "Knowledge body 7",
        confidence: 69,
        importance: 77,
        metadata: {
          sourceUri: "cover-evidence-result://10000000-0000-0000-0000-000000000007",
        },
        updatedAt: iso("2026-05-20T00:07:30.000Z"),
      },
    ]);

    const result = await listCandidateItems({
      page: 1,
      limit: 50,
      targetKind: "all",
      outcome: "all",
      hasKnowledge: "all",
    });

    expect(result.total).toBe(8);
    expect(result.stats).toEqual({
      total: 8,
      stored: 2,
      readyNotFinalized: 1,
      rejected: 1,
      retryable: 2,
      targetPending: 1,
      candidateOnly: 1,
    });

    const byId = new Map(result.items.map((item) => [item.id, item]));
    expect(byId.get("10000000-0000-0000-0000-000000000001")?.outcome).toBe("target_pending");
    expect(byId.get("10000000-0000-0000-0000-000000000002")?.outcome).toBe("candidate_only");
    expect(byId.get("10000000-0000-0000-0000-000000000003")?.outcome).toBe("ready_not_finalized");
    expect(byId.get("10000000-0000-0000-0000-000000000004")?.outcome).toBe("rejected");
    expect(byId.get("10000000-0000-0000-0000-000000000005")?.outcome).toBe("retryable");
    expect(byId.get("10000000-0000-0000-0000-000000000006")?.outcome).toBe("stored");
    expect(byId.get("10000000-0000-0000-0000-000000000007")?.outcome).toBe("stored");
    expect(byId.get("10000000-0000-0000-0000-000000000008")?.outcome).toBe("retryable");
    expect(byId.get("10000000-0000-0000-0000-000000000008")?.latestUpdatedAt).toBe(
      "2026-05-20T00:08:30.000Z",
    );

    const storedSix = byId.get("10000000-0000-0000-0000-000000000006");
    expect(storedSix?.knowledge?.id).toBe("20000000-0000-0000-0000-000000000062");

    const sourceUriOnly = byId.get("10000000-0000-0000-0000-000000000007");
    expect(sourceUriOnly?.knowledge?.id).toBe("20000000-0000-0000-0000-000000000071");

    const sortedByCandidateTitle = await listCandidateItems({
      page: 1,
      limit: 3,
      targetKind: "all",
      outcome: "all",
      hasKnowledge: "all",
      sortBy: "candidateTitle",
      sortDir: "asc",
    });

    expect(sortedByCandidateTitle.items.map((item) => item.original.title)).toEqual([
      "Candidate 1",
      "Candidate 2",
      "Candidate 3",
    ]);
  });

  test("stats ignore outcome filter while total honors it", async () => {
    await db.insert(distillationTargetStates).values([
      {
        id: "30000000-0000-0000-0000-000000000001",
        targetKind: "wiki_file",
        targetKey: "stats-target-1",
        sourceUri: "file:///workspace/wiki/stats-1.md",
        distillationVersion: "v1",
        status: "completed",
        phase: "stored",
        priorityGroup: "wiki",
        sortKey: "stats-target-1",
      },
      {
        id: "30000000-0000-0000-0000-000000000002",
        targetKind: "wiki_file",
        targetKey: "stats-target-2",
        sourceUri: "file:///workspace/wiki/stats-2.md",
        distillationVersion: "v1",
        status: "completed",
        phase: "stored",
        priorityGroup: "wiki",
        sortKey: "stats-target-2",
      },
    ]);

    await db.insert(findCandidateResults).values([
      {
        id: "31000000-0000-0000-0000-000000000001",
        targetStateId: "30000000-0000-0000-0000-000000000001",
        candidateIndex: 0,
        title: "Stats candidate 1",
        content: "stats",
        status: "selected",
      },
      {
        id: "31000000-0000-0000-0000-000000000002",
        targetStateId: "30000000-0000-0000-0000-000000000002",
        candidateIndex: 0,
        title: "Stats candidate 2",
        content: "stats",
        status: "selected",
      },
    ]);

    await db.insert(coverEvidenceResults).values([
      {
        id: "31000000-0000-0000-0000-000000000001",
        status: "duplicate",
        stage: "dedupe",
        reason: "duplicate_match",
      },
      {
        id: "31000000-0000-0000-0000-000000000002",
        status: "tool_failed",
        stage: "web",
        reason: "provider_down",
      },
    ]);

    const rejectedOnly = await listCandidateItems({
      page: 1,
      limit: 50,
      targetKind: "all",
      outcome: "rejected",
      hasKnowledge: "all",
      query: "Stats candidate",
    });

    expect(rejectedOnly.total).toBe(1);
    expect(rejectedOnly.items).toHaveLength(1);
    expect(rejectedOnly.items[0]?.outcome).toBe("rejected");
    expect(rejectedOnly.stats.rejected).toBe(1);
    expect(rejectedOnly.stats.retryable).toBe(1);
    expect(rejectedOnly.stats.total).toBe(2);
  });
});
