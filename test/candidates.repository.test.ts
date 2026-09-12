import { beforeEach, describe, expect, test, vi } from "vitest";
import type { CandidateListQuery } from "../api/modules/candidates/candidates.types.js";

const mocks = vi.hoisted(() => ({
  backendKind: "postgres" as "postgres" | "sqlite",
  execute: vi.fn(),
  sqliteAll: vi.fn(),
}));

vi.mock("../src/db/index.js", () => ({
  db: {
    execute: (...args: unknown[]) => mocks.execute(...args),
  },
}));

vi.mock("../src/db/backend.js", () => ({
  resolveDatabaseBackendConfig: () => ({ kind: mocks.backendKind }),
}));

vi.mock("../src/db/sqlite/runtime.js", () => ({
  getRuntimeSqliteCoreDatabase: () =>
    Promise.resolve({
      db: {
        query: (sql: string) => ({
          all: () => mocks.sqliteAll(sql),
        }),
      },
    }),
}));

import { listCandidateItems } from "../api/modules/candidates/candidates.repository.js";

function queryText(value: unknown, depth = 0): string {
  if (depth > 8) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((item) => queryText(item, depth + 1)).join(" ");
  if (!value || typeof value !== "object") return "";
  return Object.values(value as Record<string, unknown>)
    .map((item) => queryText(item, depth + 1))
    .join(" ");
}

function candidateRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "cand-1",
    target_state_id: "target-1",
    candidate_index: 0,
    target_kind: "wiki_file",
    target_key: "wiki/alpha",
    source_uri: "file:///wiki/alpha.md",
    finalize_source_uri: `cover-evidence-result://${overrides.id ?? "cand-1"}`,
    target_status: "completed",
    target_phase: "stored",
    target_outcome_kind: null,
    target_last_error: null,
    latest_updated_at: "2026-05-20T00:02:00.000Z",
    original_title: "Alpha title",
    original_body: "Alpha body",
    original_status: "ready",
    original_created_at: "2026-05-20T00:00:00.000Z",
    original_updated_at: "2026-05-20T00:01:00.000Z",
    cover_status: "knowledge_ready",
    cover_stage: "done",
    cover_type: "rule",
    cover_title: "Cover title",
    cover_body: "Cover body",
    cover_importance: 80,
    cover_confidence: 70,
    cover_reason: "ok",
    cover_references_count: 2,
    cover_duplicate_refs_count: 0,
    cover_tool_events_count: 1,
    cover_updated_at: "2026-05-20T00:01:30.000Z",
    knowledge_id: null,
    knowledge_type: null,
    knowledge_status: null,
    knowledge_scope: null,
    knowledge_title: null,
    knowledge_body: null,
    knowledge_importance: null,
    knowledge_confidence: null,
    knowledge_updated_at: null,
    candidate_origin_source: null,
    landscape_link_id: null,
    landscape_review_item_id: null,
    landscape_review_item_reason: null,
    landscape_review_item_evidence: [],
    landscape_link_status: null,
    outcome: "ready_not_finalized",
    ...overrides,
  };
}

function defaultQuery(overrides: Partial<CandidateListQuery> = {}): CandidateListQuery {
  return {
    page: 1,
    limit: 20,
    ...overrides,
  };
}

function stubPostgres(items: unknown[], total = items.length, stats?: Record<string, unknown>) {
  mocks.execute.mockImplementation(async (query: unknown) => {
    const text = queryText(query);
    if (text.includes("ready_not_finalized") && text.includes("as stored")) {
      return {
        rows: [
          stats ?? {
            total,
            stored: 0,
            ready_not_finalized: items.length,
            rejected: 0,
            retryable: 0,
            retained_failure: 0,
            target_pending: 0,
            candidate_only: 0,
          },
        ],
      };
    }
    if (text.includes("as total") && text.includes("count(*)")) {
      return { rows: [{ total }] };
    }
    return { rows: items };
  });
}

describe("listCandidateItems", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.backendKind = "postgres";
  });

  describe("postgres", () => {
    test("returns empty items and zeroed stats when queries return nothing", async () => {
      mocks.execute.mockResolvedValue({ rows: [] });

      const result = await listCandidateItems(defaultQuery({ query: "none", outcome: "all" }));

      expect(result.items).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.stats).toEqual({
        total: 0,
        stored: 0,
        readyNotFinalized: 0,
        rejected: 0,
        retryable: 0,
        retainedFailure: 0,
        targetPending: 0,
        candidateOnly: 0,
      });
    });

    test("maps cover, knowledge, diffs, and landscape warnings", async () => {
      stubPostgres(
        [
          candidateRow({
            knowledge_id: "k-1",
            knowledge_type: "procedure",
            knowledge_status: "active",
            knowledge_scope: "global",
            knowledge_title: "Knowledge title",
            knowledge_body: "Knowledge body",
            knowledge_importance: 90,
            knowledge_confidence: 60,
            knowledge_updated_at: "2026-05-20T00:03:00.000Z",
            outcome: "stored",
            candidate_origin_source: "landscape_review_item",
            landscape_link_id: "link-1",
            landscape_review_item_id: "review-1",
            landscape_review_item_reason: "promotion_gate_review",
            landscape_review_item_evidence: '["gate"]',
            landscape_link_status: "draft_created",
            cover_type: "note",
            original_created_at: new Date("2026-05-20T00:00:00.000Z"),
          }),
        ],
        1,
        {
          total: 1,
          stored: 1,
          ready_not_finalized: 0,
          rejected: 0,
          retryable: 0,
          retained_failure: 0,
          target_pending: 0,
          candidate_only: 0,
        },
      );

      const result = await listCandidateItems(
        defaultQuery({
          includeStored: true,
          hasKnowledge: "yes",
          outcome: "stored",
          targetKind: "wiki_file",
          targetStateId: "target-1",
          query: "Alpha",
          sortBy: "qualityScore",
          sortDir: "desc",
        }),
      );

      expect(result.total).toBe(1);
      expect(result.stats.stored).toBe(1);
      const item = result.items[0];
      expect(item?.cover?.type).toBeNull();
      expect(item?.knowledge?.id).toBe("k-1");
      expect(item?.diff.originalToCover?.titleChanged).toBe(true);
      expect(item?.diff.coverToKnowledge?.titleChanged).toBe(true);
      expect(item?.landscapeWarning).toMatchObject({
        source: "landscape_review_item",
        warningReason: "promotion_gate_review",
        requiresManualApproval: true,
        evidence: ["gate"],
      });
    });

    test("applies filter/sort branches for remaining query options", async () => {
      stubPostgres([
        candidateRow({ cover_status: null, cover_stage: null, outcome: "candidate_only" }),
      ]);

      const result = await listCandidateItems(
        defaultQuery({
          targetKind: "all",
          hasKnowledge: "no",
          outcome: "candidate_only",
          sortBy: "targetKey",
          sortDir: "asc",
        }),
      );

      expect(result.items[0]?.cover).toBeNull();
      expect(result.items[0]?.knowledge).toBeNull();
      expect(result.items[0]?.diff.originalToCover).toBeNull();
    });
  });

  describe("sqlite", () => {
    beforeEach(() => {
      mocks.backendKind = "sqlite";
    });

    test("returns empty results when sqlite has no candidates", async () => {
      mocks.sqliteAll.mockReturnValue([]);

      const result = await listCandidateItems(defaultQuery({ query: "missing" }));

      expect(result.items).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.stats.total).toBe(0);
    });

    test("joins knowledge by coverEvidenceResultId and sourceUri, then paginates", async () => {
      const storedById = candidateRow({
        id: "cand-stored",
        target_key: "wiki/stored",
        original_title: "Stored",
        latest_updated_at: "2026-05-20T00:01:00.000Z",
        outcome: "candidate_only",
      });
      const storedByUri = candidateRow({
        id: "cand-uri",
        target_key: "wiki/uri",
        original_title: "ViaUri",
        latest_updated_at: "2026-05-20T00:00:30.000Z",
        outcome: "candidate_only",
      });
      const ready = candidateRow({
        id: "cand-ready",
        target_state_id: "target-2",
        target_key: "wiki/ready",
        original_title: "Ready",
        candidate_index: 1,
        latest_updated_at: "2026-05-20T00:02:00.000Z",
        knowledge_id: null,
        outcome: "candidate_only",
      });
      mocks.sqliteAll.mockImplementation((sql: string) => {
        if (sql.includes("knowledge_items")) {
          return [
            {
              id: "k-stored",
              type: "rule",
              status: "active",
              scope: "repo",
              title: "Stored knowledge",
              body: "Stored body",
              importance: 50,
              confidence: 40,
              updated_at: "2026-05-21T00:00:00.000Z",
              metadata: JSON.stringify({ coverEvidenceResultId: "cand-stored" }),
            },
            {
              id: "k-uri",
              type: "rule",
              status: "draft",
              scope: "repo",
              title: "Via uri",
              body: "Via uri body",
              importance: 10,
              confidence: 10,
              updated_at: "2026-05-19T00:00:00.000Z",
              metadata: JSON.stringify({ sourceUri: "cover-evidence-result://cand-uri" }),
            },
            {
              id: "ignored",
              type: "rule",
              status: "draft",
              scope: "repo",
              title: "Bad metadata",
              body: "x",
              importance: null,
              confidence: null,
              updated_at: "2026-05-19T00:00:00.000Z",
              metadata: "not-json",
            },
          ];
        }
        return [storedById, storedByUri, ready];
      });

      const page1 = await listCandidateItems(
        defaultQuery({
          page: 1,
          limit: 1,
          includeStored: true,
          sortBy: "latestUpdatedAt",
          sortDir: "desc",
        }),
      );
      expect(page1.total).toBe(3);
      expect(page1.items).toHaveLength(1);
      expect(page1.items[0]?.id).toBe("cand-stored");
      expect(page1.items[0]?.outcome).toBe("stored");
      expect(page1.items[0]?.knowledge?.id).toBe("k-stored");
      expect(page1.stats.stored).toBe(2);

      const withoutStored = await listCandidateItems(defaultQuery({ includeStored: false }));
      expect(withoutStored.items.map((item) => item.id)).toEqual(["cand-ready"]);
    });

    test("filters by query, kind, outcome, knowledge, and target, then sorts", async () => {
      const rows = [
        candidateRow({
          id: "wiki-ready",
          target_kind: "wiki_file",
          target_key: "wiki/filter",
          original_title: "Needle title",
          cover_status: "knowledge_ready",
          cover_importance: 10,
          cover_confidence: 10,
          latest_updated_at: "2026-05-20T00:01:00.000Z",
          outcome: "ready_not_finalized",
        }),
        candidateRow({
          id: "vibe-rejected",
          target_kind: "vibe_memory",
          target_key: "vibe/filter",
          target_state_id: "target-vibe",
          original_title: "Other",
          cover_status: "duplicate",
          cover_importance: 90,
          cover_confidence: 90,
          latest_updated_at: "2026-05-20T00:03:00.000Z",
          outcome: "rejected",
        }),
        candidateRow({
          id: "pending",
          target_kind: "web_ingest",
          target_key: "web/pending",
          original_title: "Pending",
          cover_status: null,
          cover_stage: null,
          target_status: "pending",
          latest_updated_at: "2026-05-20T00:00:00.000Z",
          outcome: "target_pending",
        }),
      ];
      mocks.sqliteAll.mockImplementation((sql: string) =>
        sql.includes("knowledge_items") ? [] : rows,
      );

      const byQuery = await listCandidateItems(defaultQuery({ query: "needle" }));
      expect(byQuery.items.map((item) => item.id)).toEqual(["wiki-ready"]);

      const byKind = await listCandidateItems(defaultQuery({ targetKind: "vibe_memory" }));
      expect(byKind.items.map((item) => item.id)).toEqual(["vibe-rejected"]);
      expect(byKind.items[0]?.targetKind).toBe("vibe_memory");

      const byOutcome = await listCandidateItems(defaultQuery({ outcome: "rejected" }));
      expect(byOutcome.items.map((item) => item.id)).toEqual(["vibe-rejected"]);
      expect(byOutcome.stats.rejected).toBe(1);

      const byTarget = await listCandidateItems(defaultQuery({ targetStateId: "target-vibe" }));
      expect(byTarget.items.map((item) => item.id)).toEqual(["vibe-rejected"]);

      const noKnowledge = await listCandidateItems(
        defaultQuery({ hasKnowledge: "no", sortBy: "qualityScore" }),
      );
      expect(noKnowledge.items[0]?.id).toBe("vibe-rejected");

      const yesKnowledge = await listCandidateItems(defaultQuery({ hasKnowledge: "yes" }));
      expect(yesKnowledge.items).toEqual([]);

      const byTitle = await listCandidateItems(
        defaultQuery({ sortBy: "candidateTitle", sortDir: "asc", targetKind: "all" }),
      );
      expect(byTitle.items.map((item) => item.id)).toEqual([
        "wiki-ready",
        "vibe-rejected",
        "pending",
      ]);
    });

    test("recomputes sqlite outcomes and landscape review warnings", async () => {
      const rows = [
        candidateRow({
          id: "retryable",
          cover_status: "tool_failed",
          target_status: "paused",
          target_outcome_kind: "cover_evidence_retryable",
          latest_updated_at: "unix-ms:1747699200000",
          original_created_at: "2026-05-20 00:00:00",
          candidate_origin_source: "landscape_review_item",
          landscape_link_status: "review_required",
          landscape_review_item_reason: "needs look",
          landscape_review_item_evidence: ["one", " ", 1],
        }),
        candidateRow({
          id: "retained",
          cover_status: "provider_failed",
          target_status: "failed",
          latest_updated_at: "2026-05-19T00:00:00.000Z",
        }),
        candidateRow({
          id: "insufficient",
          cover_status: "insufficient",
          latest_updated_at: "2026-05-18T00:00:00.000Z",
        }),
        candidateRow({
          id: "only",
          cover_status: null,
          cover_stage: null,
          target_status: "completed",
          latest_updated_at: "2026-05-17T00:00:00.000Z",
        }),
      ];
      mocks.sqliteAll.mockImplementation((sql: string) =>
        sql.includes("knowledge_items") ? [] : rows,
      );

      const result = await listCandidateItems(
        defaultQuery({ sortBy: "outcome", sortDir: "asc", includeStored: true }),
      );

      const byId = Object.fromEntries(result.items.map((item) => [item.id, item]));
      expect(byId.retryable?.outcome).toBe("retryable");
      expect(byId.retryable?.landscapeWarning?.warningReason).toBe("review_required");
      expect(byId.retryable?.landscapeWarning?.evidence).toEqual(["one"]);
      expect(byId.retained?.outcome).toBe("retained_failure");
      expect(byId.insufficient?.outcome).toBe("rejected");
      expect(byId.only?.outcome).toBe("candidate_only");
      expect(result.stats.retryable).toBe(1);
      expect(result.stats.retainedFailure).toBe(1);
      expect(result.stats.candidateOnly).toBe(1);
    });

    test("sorts by coverage and knowledge status with updatedAt ties", async () => {
      const rows = [
        candidateRow({
          id: "a",
          candidate_index: 2,
          cover_status: "duplicate",
          knowledge_status: null,
          latest_updated_at: "2026-05-20T00:00:00.000Z",
        }),
        candidateRow({
          id: "b",
          candidate_index: 1,
          cover_status: "duplicate",
          knowledge_status: "draft",
          latest_updated_at: "2026-05-20T00:00:00.000Z",
        }),
      ];
      mocks.sqliteAll.mockImplementation((sql: string) =>
        sql.includes("knowledge_items") ? [] : rows,
      );

      const byCoverage = await listCandidateItems(
        defaultQuery({ sortBy: "coverageStatus", sortDir: "asc" }),
      );
      expect(byCoverage.items.map((item) => item.id)).toEqual(["b", "a"]);

      const byKnowledge = await listCandidateItems(
        defaultQuery({ sortBy: "knowledgeStatus", sortDir: "desc" }),
      );
      expect(byKnowledge.items[0]?.id).toBe("b");
    });
  });
});
