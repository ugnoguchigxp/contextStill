import { beforeEach, describe, expect, test, vi } from "vitest";
import { getRuntimeSqliteCoreDatabase } from "../src/db/sqlite/runtime.js";
import {
  getCompileEvalSummaryByRunId,
  listCompileEvalsByRunId,
} from "../src/modules/context-compiler/context-compile-eval.repository.js";
import {
  findContextCompileTaskTraceByRunIdSqlite,
  getCompileRunDetailSqlite,
  getCompileRunRankingTraceSqlite,
  getCompileRunSnapshotSqlite,
  insertCompileRunSqlite,
  insertContextCompileCandidateTracesSqlite,
  insertContextPackItemsSqlite,
  listRecentCompileRunsSqlite,
  listRecentContextCompileTaskTracesSqlite,
  parseSqliteRunInput,
  saveRunEpisodeFeedbackSqlite,
  updateCompileRunFailureSqlite,
  updateCompileRunSnapshotSqlite,
  upsertContextCompileTaskTraceSqlite,
} from "../src/modules/context-compiler/context-compiler.repository.sqlite.js";
import type { ContextPack } from "../src/shared/schemas/context-pack.schema.js";

vi.mock("../src/db/sqlite/runtime.js", () => {
  const mockDb = {
    query: vi.fn(),
    exec: vi.fn(),
    close: vi.fn(),
  };
  return {
    getRuntimeSqliteCoreDatabase: vi.fn(() =>
      Promise.resolve({
        db: mockDb,
        path: "/dummy/sqlite.db",
      }),
    ),
  };
});

vi.mock("../src/modules/context-compiler/context-compile-eval.repository.js", () => ({
  getCompileEvalSummaryByRunId: vi.fn(),
  listCompileEvalsByRunId: vi.fn(),
}));

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const KNOWLEDGE_ID = "22222222-2222-4222-8222-222222222222";
const EPISODE_ID = "33333333-3333-4333-8333-333333333333";
const FEEDBACK_ID = "44444444-4444-4444-8444-444444444444";
const EVAL_ID = "55555555-5555-4555-8555-555555555555";
const CREATED_AT = "2026-05-21T08:00:00.000Z";

const emptyEvalSummary = {
  count: 0,
  latestAvg: null,
  averageAvg: null,
  latestOutcome: null,
  latestEvaluatedAt: null,
};

function pack(overrides: Partial<ContextPack> = {}): ContextPack {
  return {
    runId: RUN_ID,
    goal: "Cover sqlite compile runs",
    retrievalMode: "task_context",
    status: "ok",
    minimalTasks: [],
    rules: [
      {
        id: `rule:${KNOWLEDGE_ID}`,
        itemKind: "rule",
        itemId: KNOWLEDGE_ID,
        section: "rules",
        title: "Write repository tests",
        content: "Exercise sqlite compile run mapping.",
        score: 0.91,
        rankingReason: "text_score",
        sourceRefs: ["src/repo.ts"],
      },
    ],
    procedures: [
      {
        id: `episode_card:${EPISODE_ID}`,
        itemKind: "episode_card",
        itemId: EPISODE_ID,
        section: "procedures",
        title: "Episode lesson",
        content: "Keep mapping deterministic.",
        score: 0.4,
        rankingReason: "text_score",
        sourceRefs: [],
      },
    ],
    guardrails: [],
    warnings: [],
    sourceRefs: ["src/repo.ts"],
    diagnostics: {
      degradedReasons: [],
      retrievalStats: {
        responseComposer: { markdownKind: "narrative", outputMarkdown: "# Pack" },
      },
    },
    ...overrides,
  };
}

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    goal: "Cover sqlite compile runs",
    intent: "edit",
    session_id: null,
    repo_path: "/repo",
    input: JSON.stringify({ goal: "Cover sqlite compile runs" }),
    retrieval_mode: "task_context",
    status: "ok",
    degraded_reasons: JSON.stringify(["slow"]),
    token_budget: 4000,
    duration_ms: 12,
    source: "mcp",
    pack_snapshot: JSON.stringify(pack()),
    created_at: CREATED_AT,
    ...overrides,
  };
}

function statement(options?: { get?: unknown; all?: unknown[]; throwOnRun?: Error }) {
  return {
    run: options?.throwOnRun
      ? vi.fn((..._params: unknown[]) => {
          throw options.throwOnRun;
        })
      : vi.fn((..._params: unknown[]) => ({ changes: 1 })),
    get: vi.fn(() => options?.get ?? null),
    all: vi.fn(() => options?.all ?? []),
  };
}

describe("context-compiler.repository.sqlite", () => {
  let mockDb: { query: ReturnType<typeof vi.fn>; exec: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.clearAllMocks();
    mockDb = (await getRuntimeSqliteCoreDatabase()).db as unknown as typeof mockDb;
    vi.mocked(getCompileEvalSummaryByRunId).mockResolvedValue(emptyEvalSummary);
    vi.mocked(listCompileEvalsByRunId).mockResolvedValue([]);
    mockDb.query.mockImplementation((sql: string) => statement({ all: [], get: null }));
  });

  test("insertCompileRunSqlite writes a run row and returns an id", async () => {
    const insert = statement();
    mockDb.query.mockReturnValue(insert);
    const id = await insertCompileRunSqlite({
      goal: "goal",
      intent: "edit",
      input: { q: "x" },
      retrievalMode: "task_context",
      status: "ok",
      degradedReasons: ["a"],
      tokenBudget: 10.8,
      durationMs: 3.2,
    });
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(insert.run).toHaveBeenCalled();
    expect(insert.run.mock.calls[0]?.[1]).toBe("goal");
    expect(insert.run.mock.calls[0]?.[14]).toBe(10);
    expect(insert.run.mock.calls[0]?.[15]).toBe(3);
  });

  test("updateCompileRunSnapshotSqlite and updateCompileRunFailureSqlite persist snapshots", async () => {
    const update = statement();
    mockDb.query.mockReturnValue(update);
    await updateCompileRunSnapshotSqlite(RUN_ID, pack());
    await updateCompileRunFailureSqlite({
      runId: RUN_ID,
      degradedReasons: ["failed"],
      durationMs: 9.4,
      pack: pack({ status: "failed" }),
    });
    expect(update.run).toHaveBeenCalledTimes(2);
    expect(update.run.mock.calls[1]?.[1]).toBe(9);
  });

  test("insertContextPackItemsSqlite skips empty input, commits items, and rolls back on error", async () => {
    await insertContextPackItemsSqlite(RUN_ID, []);
    expect(mockDb.query).not.toHaveBeenCalled();

    const begin = statement();
    const insert = statement();
    const commit = statement();
    mockDb.query.mockImplementation((sql: string) => {
      if (sql.includes("BEGIN")) return begin;
      if (sql.includes("COMMIT")) return commit;
      if (sql.includes("INSERT INTO context_pack_items")) return insert;
      return statement();
    });
    await insertContextPackItemsSqlite(RUN_ID, [
      {
        itemKind: "rule",
        itemId: KNOWLEDGE_ID,
        section: "rules",
        score: Number.NaN,
        rankingReason: "text",
        sourceRefs: ["a"],
      },
    ]);
    expect(begin.run).toHaveBeenCalled();
    expect(commit.run).toHaveBeenCalled();
    expect(insert.run.mock.calls[0]?.[4]).toBe(0);

    const rollback = statement();
    mockDb.query.mockImplementation((sql: string) => {
      if (sql.includes("ROLLBACK")) return rollback;
      if (sql.includes("INSERT INTO context_pack_items")) {
        return statement({ throwOnRun: new Error("pack insert failed") });
      }
      return statement();
    });
    await expect(
      insertContextPackItemsSqlite(RUN_ID, [
        {
          itemKind: "procedure",
          itemId: EPISODE_ID,
          section: "procedures",
          score: 1,
          rankingReason: "text",
          sourceRefs: [],
        },
      ]),
    ).rejects.toThrow("pack insert failed");
    expect(rollback.run).toHaveBeenCalled();
  });

  test("insertContextCompileCandidateTracesSqlite commits and rolls back", async () => {
    await insertContextCompileCandidateTracesSqlite(RUN_ID, []);
    const insert = statement();
    const rollback = statement();
    mockDb.query.mockImplementation((sql: string) => {
      if (sql.includes("INSERT INTO context_compile_candidate_traces")) return insert;
      if (sql.includes("ROLLBACK")) return rollback;
      return statement();
    });
    await insertContextCompileCandidateTracesSqlite(RUN_ID, [
      {
        itemKind: "rule",
        itemId: KNOWLEDGE_ID,
        textRank: 1,
        textScore: 0.9,
        vectorRank: null,
        vectorScore: null,
        mergedRank: 1,
        mergedScore: 0.9,
        finalRank: 1,
        finalScore: 0.9,
        selected: true,
        suppressed: false,
        suppressionReason: null,
        agenticDecision: "accepted",
        rankingReason: "keep",
        communityKey: "c1",
        evidence: { k: 1 },
      },
    ]);
    expect(insert.run).toHaveBeenCalled();

    mockDb.query.mockImplementation((sql: string) => {
      if (sql.includes("INSERT INTO context_compile_candidate_traces")) {
        return statement({ throwOnRun: new Error("trace insert failed") });
      }
      if (sql.includes("ROLLBACK")) return rollback;
      return statement();
    });
    await expect(
      insertContextCompileCandidateTracesSqlite(RUN_ID, [
        {
          itemKind: "procedure",
          itemId: KNOWLEDGE_ID,
          textRank: null,
          textScore: null,
          vectorRank: 2,
          vectorScore: 0.2,
          mergedRank: 2,
          mergedScore: 0.2,
          finalRank: 2,
          finalScore: 0.2,
          selected: false,
          suppressed: true,
          suppressionReason: "dup",
          agenticDecision: "rejected",
          rankingReason: null,
          communityKey: null,
          evidence: {},
        },
      ]),
    ).rejects.toThrow("trace insert failed");
  });

  test("listRecentCompileRunsSqlite maps rows and clamps the limit", async () => {
    mockDb.query.mockImplementation((sql: string) => {
      if (sql.includes("FROM context_compile_runs")) {
        return statement({ all: [runRow()] });
      }
      return statement();
    });
    const rows = await listRecentCompileRunsSqlite(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: RUN_ID,
      goal: "Cover sqlite compile runs",
      retrievalMode: "task_context",
      status: "ok",
      source: "mcp",
    });
    expect(mockDb.query.mock.calls[0]?.[0]).toContain("LIMIT ?");
    const limitStmt = mockDb.query.mock.results[0]?.value as { all: ReturnType<typeof vi.fn> };
    expect(limitStmt.all).toHaveBeenCalledWith(1);
  });

  test("getCompileRunSnapshotSqlite returns null or mapped items", async () => {
    mockDb.query.mockImplementation((sql: string) => {
      if (sql.includes("FROM context_compile_runs")) return statement({ get: null });
      return statement();
    });
    expect(await getCompileRunSnapshotSqlite(RUN_ID)).toBeNull();

    mockDb.query.mockImplementation((sql: string) => {
      if (sql.includes("FROM context_compile_runs")) return statement({ get: runRow() });
      if (sql.includes("FROM context_pack_items")) {
        return statement({
          all: [
            {
              item_kind: "rule",
              item_id: KNOWLEDGE_ID,
              section: "rules",
              score: "0.5",
              ranking_reason: "text",
              source_refs: JSON.stringify(["a"]),
              created_at: CREATED_AT,
            },
            {
              item_kind: "knowledge",
              item_id: KNOWLEDGE_ID,
              section: "procedures",
              score: 1,
              ranking_reason: "packed",
              source_refs: "not-json",
              created_at: CREATED_AT,
            },
            {
              item_kind: "episode_card",
              item_id: EPISODE_ID,
              section: "guardrails",
              score: 1,
              ranking_reason: "episode",
              source_refs: "[]",
              created_at: CREATED_AT,
            },
          ],
        });
      }
      return statement();
    });
    const snapshot = await getCompileRunSnapshotSqlite(RUN_ID);
    expect(snapshot?.items.map((item) => item.section)).toEqual([
      "rules",
      "procedures",
      "guardrails",
    ]);
  });

  test("getCompileRunDetailSqlite maps pack, feedback override, and rust-native snapshots", async () => {
    vi.mocked(listCompileEvalsByRunId).mockResolvedValue([
      {
        id: EVAL_ID,
        runId: RUN_ID,
        sessionId: null,
        avg: 80,
        outcome: "useful",
        title: "eval",
        body: "body",
        source: "ui",
        relevance: 80,
        actionability: 70,
        coverage: 60,
        clarity: 50,
        specificity: 40,
        createdAt: new Date(CREATED_AT),
        updatedAt: new Date(CREATED_AT),
      },
    ]);
    mockDb.query.mockImplementation((sql: string) => {
      if (sql.includes("FROM context_compile_runs")) return statement({ get: runRow() });
      if (sql.includes("FROM context_pack_items")) {
        return statement({
          all: [
            {
              item_kind: "rule",
              item_id: KNOWLEDGE_ID,
              section: "rules",
              score: 0.9,
              ranking_reason: "text",
              source_refs: JSON.stringify(["src/repo.ts"]),
              created_at: CREATED_AT,
            },
            {
              item_kind: "episode_card",
              item_id: EPISODE_ID,
              section: "procedures",
              score: 0.2,
              ranking_reason: "episode",
              source_refs: "[]",
              created_at: CREATED_AT,
            },
            {
              item_kind: "knowledge",
              item_id: KNOWLEDGE_ID,
              section: "rules",
              score: 0.1,
              ranking_reason: "dup",
              source_refs: "[]",
              created_at: CREATED_AT,
            },
          ],
        });
      }
      if (sql.includes("FROM knowledge_usage_events")) {
        return statement({
          all: [
            {
              id: FEEDBACK_ID,
              run_id: RUN_ID,
              knowledge_id: KNOWLEDGE_ID,
              verdict: "wrong",
              actor: "user",
              reason: "override",
              metadata: JSON.stringify({
                autoVerdict: "used",
                autoActor: "agent",
                autoReason: "auto",
              }),
              updated_at: CREATED_AT,
              created_at: CREATED_AT,
            },
          ],
        });
      }
      if (sql.includes("FROM episode_retrieval_feedback")) {
        return statement({
          all: [
            {
              episode_card_id: EPISODE_ID,
              verdict: "not_relevant",
              reason: "stale",
              metadata: JSON.stringify({ actor: "user" }),
              created_at: CREATED_AT,
            },
            {
              episode_card_id: EPISODE_ID,
              verdict: "ignored",
              reason: null,
              created_at: CREATED_AT,
            },
          ],
        });
      }
      if (sql.includes("FROM knowledge_items")) {
        return statement({
          all: [
            {
              id: KNOWLEDGE_ID,
              title: "Write repository tests",
              status: "active",
              applies_to: JSON.stringify({
                changeTypes: ["test"],
                technologies: ["sqlite"],
                domains: ["compiler"],
              }),
            },
          ],
        });
      }
      return statement();
    });

    const detail = await getCompileRunDetailSqlite(RUN_ID);
    expect(detail?.knowledgeSignals[0]).toMatchObject({
      knowledgeId: KNOWLEDGE_ID,
      effectiveActor: "user",
      effectiveVerdict: "wrong",
      autoVerdict: "used",
      hasUserOverride: true,
    });
    expect(detail?.episodeSignals[0]).toMatchObject({
      episodeId: EPISODE_ID,
      effectiveVerdict: "not_used",
    });
    expect(detail?.evaluations).toHaveLength(1);
    expect(detail?.outputMarkdown).toBe("# Pack");

    const rustRow = runRow({
      pack_snapshot: JSON.stringify({
        outputMarkdown: "No Content",
        diagnostics: { engine: "rust-native", degradedReasons: [] },
        rules: [
          {
            id: KNOWLEDGE_ID,
            type: "rule",
            title: "R",
            body: "rule body",
            score: 1,
            sourceRefs: [],
          },
        ],
        procedures: [{ id: "", type: "procedure", title: "skip" }],
        episodes: [
          { id: EPISODE_ID, title: "E", lesson: "L", situation: "S", score: 0.2 },
          { id: "", title: "skip" },
        ],
      }),
    });
    mockDb.query.mockImplementation((sql: string) => {
      if (sql.includes("FROM context_compile_runs")) return statement({ get: rustRow });
      if (sql.includes("FROM knowledge_items")) return statement({ all: [] });
      return statement({ all: [] });
    });
    const rustDetail = await getCompileRunDetailSqlite(RUN_ID);
    expect(rustDetail?.pack?.procedures.some((item) => item.itemKind === "episode_card")).toBe(
      true,
    );

    mockDb.query.mockImplementation((sql: string) => {
      if (sql.includes("FROM context_compile_runs")) return statement({ get: null });
      return statement();
    });
    expect(await getCompileRunDetailSqlite(RUN_ID)).toBeNull();
  });

  test("getCompileRunRankingTraceSqlite uses traces or pack fallback and sorts selected items first", async () => {
    const otherId = "66666666-6666-4666-8666-666666666666";
    mockDb.query.mockImplementation((sql: string) => {
      if (sql.includes("FROM context_compile_runs")) return statement({ get: runRow() });
      if (sql.includes("FROM context_compile_candidate_traces")) {
        return statement({
          all: [
            {
              item_kind: "rule",
              item_id: KNOWLEDGE_ID,
              text_rank: 2,
              text_score: 0.4,
              vector_rank: null,
              vector_score: null,
              merged_rank: 2,
              merged_score: 0.4,
              final_rank: 2,
              final_score: 0.4,
              selected: 0,
              suppressed: 1,
              suppression_reason: "dup",
              agentic_decision: "weird",
              ranking_reason: "later",
              community_key: null,
            },
            {
              item_kind: "procedure",
              item_id: otherId,
              text_rank: 1,
              text_score: 0.9,
              vector_rank: 1,
              vector_score: 0.8,
              merged_rank: 1,
              merged_score: 0.85,
              final_rank: 1,
              final_score: 0.85,
              selected: 1,
              suppressed: 0,
              suppression_reason: null,
              agentic_decision: "accepted",
              ranking_reason: "top",
              community_key: "comm",
            },
          ],
        });
      }
      if (sql.includes("FROM knowledge_items")) {
        return statement({
          all: [
            { id: otherId, title: "Proc", status: "draft" },
            { id: KNOWLEDGE_ID, title: "Rule", status: "mystery" },
          ],
        });
      }
      if (sql.includes("FROM context_pack_items")) {
        return statement({
          all: [
            {
              item_kind: "procedure",
              item_id: otherId,
              section: "procedures",
              score: 0.85,
              ranking_reason: "top",
              source_refs: JSON.stringify(["p.ts"]),
              created_at: CREATED_AT,
            },
          ],
        });
      }
      if (sql.includes("FROM knowledge_usage_events")) {
        return statement({
          all: [
            {
              knowledge_id: otherId,
              verdict: "used",
              actor: "agent",
              reason: "fit",
              updated_at: CREATED_AT,
              created_at: CREATED_AT,
            },
          ],
        });
      }
      return statement();
    });
    const traced = await getCompileRunRankingTraceSqlite(RUN_ID);
    expect(traced?.items[0]?.itemId).toBe(otherId);
    expect(traced?.items[0]?.packed).toBe(true);
    expect(traced?.items[1]?.agenticDecision).toBe("not_evaluated");
    expect(traced?.funnel.suppressedCount).toBe(1);
    expect(traced?.feedbackSummary.used).toBe(1);

    mockDb.query.mockImplementation((sql: string) => {
      if (sql.includes("FROM context_compile_runs")) {
        return statement({ get: runRow({ pack_snapshot: "not-json", repo_path: null }) });
      }
      if (sql.includes("FROM context_compile_candidate_traces")) return statement({ all: [] });
      if (sql.includes("FROM context_pack_items")) {
        return statement({
          all: [
            {
              item_kind: "rule",
              item_id: KNOWLEDGE_ID,
              section: "rules",
              score: 0.7,
              ranking_reason: "",
              source_refs: "[]",
              created_at: CREATED_AT,
            },
            {
              item_kind: "episode",
              item_id: EPISODE_ID,
              section: "procedures",
              score: 0.1,
              ranking_reason: "skip",
              source_refs: "[]",
              created_at: CREATED_AT,
            },
          ],
        });
      }
      return statement({ all: [] });
    });
    const fallback = await getCompileRunRankingTraceSqlite(RUN_ID);
    expect(fallback?.items).toHaveLength(1);
    expect(fallback?.items[0]?.rankingReason).toBe("packed_without_candidate_trace");

    mockDb.query.mockImplementation((sql: string) => {
      if (sql.includes("FROM context_compile_runs")) return statement({ get: null });
      return statement();
    });
    expect(await getCompileRunRankingTraceSqlite(RUN_ID)).toBeNull();
  });

  test("saveRunEpisodeFeedbackSqlite validates run, duplicates, selectable ids, and rolls back", async () => {
    mockDb.query.mockImplementation((sql: string) => {
      if (sql.includes("FROM context_compile_runs")) return statement({ get: null });
      return statement();
    });
    await expect(
      saveRunEpisodeFeedbackSqlite({
        runId: RUN_ID,
        items: [{ episodeId: EPISODE_ID, verdict: "used" }],
      }),
    ).rejects.toMatchObject({ statusCode: 404 });

    mockDb.query.mockImplementation((sql: string) => {
      if (sql.includes("FROM context_compile_runs")) return statement({ get: { id: RUN_ID } });
      if (sql.includes("FROM context_pack_items")) {
        return statement({ all: [{ item_id: EPISODE_ID }] });
      }
      return statement();
    });
    await expect(
      saveRunEpisodeFeedbackSqlite({
        runId: RUN_ID,
        items: [
          { episodeId: EPISODE_ID, verdict: "used" },
          { episodeId: EPISODE_ID, verdict: "wrong" },
        ],
      }),
    ).rejects.toMatchObject({ statusCode: 400 });

    await expect(
      saveRunEpisodeFeedbackSqlite({
        runId: RUN_ID,
        items: [{ episodeId: "missing", verdict: "used" }],
      }),
    ).rejects.toMatchObject({ statusCode: 400 });

    const insert = statement();
    const commit = statement();
    mockDb.query.mockImplementation((sql: string) => {
      if (sql.includes("FROM context_compile_runs")) return statement({ get: { id: RUN_ID } });
      if (sql.includes("FROM context_pack_items")) {
        return statement({ all: [{ item_id: EPISODE_ID }] });
      }
      if (sql.includes("INSERT INTO episode_retrieval_feedback")) return insert;
      if (sql.includes("COMMIT")) return commit;
      return statement();
    });
    const saved = await saveRunEpisodeFeedbackSqlite({
      runId: RUN_ID,
      items: [{ episodeId: ` ${EPISODE_ID} `, verdict: "not_used", reason: "  stale  " }],
    });
    expect(saved).toEqual({ savedCount: 1, affectedEpisodeIds: [EPISODE_ID] });
    expect(insert.run.mock.calls[0]?.[3]).toBe("not_relevant");
    expect(commit.run).toHaveBeenCalled();

    const rollback = statement();
    mockDb.query.mockImplementation((sql: string) => {
      if (sql.includes("FROM context_compile_runs")) return statement({ get: { id: RUN_ID } });
      if (sql.includes("FROM context_pack_items")) {
        return statement({ all: [{ item_id: EPISODE_ID }] });
      }
      if (sql.includes("INSERT INTO episode_retrieval_feedback")) {
        return statement({ throwOnRun: new Error("feedback insert failed") });
      }
      if (sql.includes("ROLLBACK")) return rollback;
      return statement();
    });
    await expect(
      saveRunEpisodeFeedbackSqlite({
        runId: RUN_ID,
        items: [{ episodeId: EPISODE_ID, verdict: "used" }],
      }),
    ).rejects.toThrow("feedback insert failed");
    expect(rollback.run).toHaveBeenCalled();
  });

  test("upserts and lists compile task traces including invalid enum fallbacks", async () => {
    const upsert = statement();
    mockDb.query.mockReturnValue(upsert);
    await upsertContextCompileTaskTraceSqlite({
      runId: RUN_ID,
      retrievalMode: "task_context",
      projectRef: "proj",
      repoPath: "/repo",
      repoKey: "org/repo",
      matchBasis: "repo_path",
      identityContractVersion: 1,
      scopeMode: "project",
      identityFingerprint: "fp",
      identityTrust: "trusted_adapter",
      bindingStatus: "verified",
      technologies: ["ts"],
      changeTypes: ["test"],
      domains: ["compiler"],
      embeddingStatus: "embedding_available",
      embeddingProvider: "openai",
      embeddingModel: "text-embedding-3-small",
      embeddingDimensions: 3,
      embedding: [0.1, 0.2, 0.3],
      goalHash: "hash",
    });
    expect(upsert.run).toHaveBeenCalled();

    const taskRow = {
      run_id: RUN_ID,
      retrieval_mode: "task_context",
      project_ref: "proj",
      repo_path: "/repo",
      repo_key: "org/repo",
      match_basis: "mystery",
      identity_contract_version: 0,
      scope_mode: "other",
      identity_fingerprint: "fp",
      identity_trust: "other",
      binding_status: "other",
      technologies: JSON.stringify(["ts"]),
      change_types: "not-json",
      domains: JSON.stringify(["compiler"]),
      embedding_status: "unknown",
      embedding_provider: null,
      embedding_model: null,
      embedding_dimensions: null,
      embedding: JSON.stringify([1, "x", 2]),
      goal_hash: "hash",
      created_at: `unix-ms:${Date.parse(CREATED_AT)}`,
      updated_at: CREATED_AT.replace("T", " ").replace("Z", ""),
    };
    mockDb.query.mockImplementation((sql: string) => {
      if (sql.includes("WHERE run_id = ? LIMIT 1")) return statement({ get: taskRow });
      if (sql.includes("run_id != ?")) return statement({ all: [taskRow] });
      if (sql.includes("FROM context_compile_task_traces")) return statement({ all: [taskRow] });
      return statement();
    });
    const found = await findContextCompileTaskTraceByRunIdSqlite(RUN_ID);
    expect(found).toMatchObject({
      runId: RUN_ID,
      matchBasis: "none",
      scopeMode: "global_only",
      identityTrust: "request_hint",
      bindingStatus: "not_applicable",
      embeddingStatus: "facets_only",
      embedding: [1, 2],
    });
    expect(await listRecentContextCompileTaskTracesSqlite({ limit: 5000 })).toHaveLength(1);
    expect(
      await listRecentContextCompileTaskTracesSqlite({ limit: 2, excludeRunId: RUN_ID }),
    ).toHaveLength(1);
    mockDb.query.mockImplementation(() => statement({ get: null, all: [] }));
    expect(await findContextCompileTaskTraceByRunIdSqlite("missing")).toBeNull();
  });

  test("parseSqliteRunInput accepts objects, invalid json, and empty values", () => {
    expect(parseSqliteRunInput(runRow())).toEqual({ goal: "Cover sqlite compile runs" });
    expect(parseSqliteRunInput(runRow({ input: "not-json" }))).toEqual({});
    expect(parseSqliteRunInput(runRow({ input: null }))).toEqual({});
  });
});
