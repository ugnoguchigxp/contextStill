import { randomUUID } from "node:crypto";
import { getRuntimeSqliteCoreDatabase } from "../../db/sqlite/runtime.js";
import type { ContextPack } from "../../shared/schemas/context-pack.schema.js";
import { contextPackSchema } from "../../shared/schemas/context-pack.schema.js";
import { asRecord } from "../../shared/utils/normalize.js";
import type { ContextCompileTaskTrace } from "./context-compile-task-trace.repository.js";
import type {
  CompileFreshnessMarkers,
  CompileRunSnapshot,
  CompileRunSummary,
} from "./context-compiler.repository.js";
import {
  extractCompileRunSignals,
  extractOutputMarkdown,
  normalizeCompileRunSource,
  normalizeDate,
  normalizeDuration,
  normalizeRunStatus,
  normalizeStringArray,
} from "./context-compiler.repository.utils.js";

type SqliteRunRow = {
  id: string;
  goal: string;
  intent: string;
  session_id: string | null;
  repo_path: string | null;
  input: string;
  retrieval_mode: string;
  status: string;
  degraded_reasons: string;
  token_budget: number;
  duration_ms: number;
  source: string;
  pack_snapshot: string | null;
  created_at: string;
};

type SqlitePackItemRow = {
  item_kind: string;
  item_id: string;
  section: string;
  score: number;
  ranking_reason: string;
  source_refs: string;
  created_at: string;
};

const emptyEvalSummary = {
  count: 0,
  latestAvg: null,
  averageAvg: null,
  latestOutcome: null,
  latestEvaluatedAt: null,
} as const;

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parseJson(value: string | null | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parsePackSnapshot(value: string | null): ContextPack | null {
  const parsed = contextPackSchema.safeParse(parseJson(value));
  return parsed.success ? parsed.data : null;
}

function mapRunSummary(row: SqliteRunRow): CompileRunSummary {
  const signals = extractCompileRunSignals(parseJson(row.pack_snapshot));
  return {
    id: row.id,
    goal: row.goal,
    retrievalMode: row.retrieval_mode,
    status: normalizeRunStatus(row.status),
    degradedReasons: normalizeStringArray(parseJson(row.degraded_reasons)),
    durationMs: normalizeDuration(row.duration_ms),
    source: normalizeCompileRunSource(row.source),
    evalSummary: { ...emptyEvalSummary },
    selectedItemCount: signals.selectedItemCount,
    outputMarkdownKind: signals.outputMarkdownKind,
    createdAt: normalizeDate(row.created_at),
  };
}

function mapPackItem(row: SqlitePackItemRow) {
  return {
    itemKind: row.item_kind,
    itemId: row.item_id,
    section:
      row.section === "procedures"
        ? "procedures"
        : row.section === "guardrails"
          ? "guardrails"
          : row.section === "code_context"
            ? "code_context"
            : row.section === "warnings"
              ? "warnings"
              : "rules",
    score: Number(row.score) || 0,
    rankingReason: row.ranking_reason,
    sourceRefs: normalizeStringArray(parseJson(row.source_refs)),
  };
}

export async function insertCompileRunSqlite(params: {
  goal: string;
  intent: string;
  sessionId?: string;
  repoPath?: string;
  input: Record<string, unknown>;
  retrievalMode: string;
  status: "ok" | "degraded" | "failed";
  degradedReasons: string[];
  tokenBudget: number;
  durationMs: number;
  source?: string;
}): Promise<string> {
  const sqlite = await getRuntimeSqliteCoreDatabase();
  const id = randomUUID();
  sqlite.db
    .query(
      `INSERT INTO context_compile_runs (
        id, goal, intent, session_id, repo_path, input, retrieval_mode, status,
        degraded_reasons, token_budget, duration_ms, source, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      params.goal,
      params.intent,
      params.sessionId ?? null,
      params.repoPath ?? null,
      json(params.input),
      params.retrievalMode,
      params.status,
      json(params.degradedReasons),
      Math.max(0, Math.trunc(params.tokenBudget)),
      Math.max(0, Math.trunc(params.durationMs)),
      params.source ?? "unknown",
      new Date().toISOString(),
    );
  return id;
}

export async function updateCompileRunSnapshotSqlite(
  runId: string,
  pack: ContextPack,
): Promise<void> {
  const sqlite = await getRuntimeSqliteCoreDatabase();
  sqlite.db
    .query("UPDATE context_compile_runs SET pack_snapshot = ? WHERE id = ?")
    .run(json(pack), runId);
}

export async function updateCompileRunFailureSqlite(params: {
  runId: string;
  degradedReasons: string[];
  durationMs: number;
  pack: ContextPack;
}): Promise<void> {
  const sqlite = await getRuntimeSqliteCoreDatabase();
  sqlite.db
    .query(
      `UPDATE context_compile_runs
       SET status = 'failed', degraded_reasons = ?, duration_ms = ?, pack_snapshot = ?
       WHERE id = ?`,
    )
    .run(
      json(params.degradedReasons),
      Math.max(0, Math.trunc(params.durationMs)),
      json(params.pack),
      params.runId,
    );
}

export async function insertContextPackItemsSqlite(
  runId: string,
  items: Array<{
    itemKind: string;
    itemId: string;
    section: "rules" | "procedures" | "code_context" | "warnings" | "guardrails";
    score: number;
    rankingReason: string;
    sourceRefs: string[];
  }>,
): Promise<void> {
  if (items.length === 0) return;
  const sqlite = await getRuntimeSqliteCoreDatabase();
  const stmt = sqlite.db.query(
    `INSERT INTO context_pack_items (
      run_id, item_kind, item_id, section, score, ranking_reason, source_refs, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const now = new Date().toISOString();
  sqlite.db.query("BEGIN IMMEDIATE").run();
  try {
    for (const item of items) {
      stmt.run(
        runId,
        item.itemKind,
        item.itemId,
        item.section,
        Number.isFinite(item.score) ? item.score : 0,
        item.rankingReason,
        json(item.sourceRefs),
        now,
      );
    }
    sqlite.db.query("COMMIT").run();
  } catch (error) {
    sqlite.db.query("ROLLBACK").run();
    throw error;
  }
}

export async function insertContextCompileCandidateTracesSqlite(
  runId: string,
  items: Array<{
    itemKind: "rule" | "procedure";
    itemId: string;
    textRank: number | null;
    textScore: number | null;
    vectorRank: number | null;
    vectorScore: number | null;
    mergedRank: number | null;
    mergedScore: number | null;
    finalRank: number | null;
    finalScore: number | null;
    selected: boolean;
    suppressed: boolean;
    suppressionReason: string | null;
    agenticDecision: "not_evaluated" | "accepted" | "rejected" | "skipped";
    rankingReason: string | null;
    communityKey: string | null;
    evidence: Record<string, unknown>;
  }>,
): Promise<void> {
  if (items.length === 0) return;
  const sqlite = await getRuntimeSqliteCoreDatabase();
  const stmt = sqlite.db.query(
    `INSERT INTO context_compile_candidate_traces (
      run_id, item_kind, item_id, text_rank, text_score, vector_rank, vector_score,
      merged_rank, merged_score, final_rank, final_score, selected, suppressed,
      suppression_reason, agentic_decision, ranking_reason, community_key, evidence, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const now = new Date().toISOString();
  sqlite.db.query("BEGIN IMMEDIATE").run();
  try {
    for (const item of items) {
      stmt.run(
        runId,
        item.itemKind,
        item.itemId,
        item.textRank,
        item.textScore,
        item.vectorRank,
        item.vectorScore,
        item.mergedRank,
        item.mergedScore,
        item.finalRank,
        item.finalScore,
        item.selected ? 1 : 0,
        item.suppressed ? 1 : 0,
        item.suppressionReason,
        item.agenticDecision,
        item.rankingReason,
        item.communityKey,
        json(item.evidence),
        now,
      );
    }
    sqlite.db.query("COMMIT").run();
  } catch (error) {
    sqlite.db.query("ROLLBACK").run();
    throw error;
  }
}

export async function listRecentCompileRunsSqlite(limit = 20): Promise<CompileRunSummary[]> {
  const sqlite = await getRuntimeSqliteCoreDatabase();
  const rows = sqlite.db
    .query<SqliteRunRow, [number]>(
      "SELECT * FROM context_compile_runs ORDER BY created_at DESC, id DESC LIMIT ?",
    )
    .all(Math.min(100, Math.max(1, Math.floor(limit))));
  return rows.map(mapRunSummary);
}

export async function getCompileRunSnapshotSqlite(
  runId: string,
): Promise<CompileRunSnapshot | null> {
  const sqlite = await getRuntimeSqliteCoreDatabase();
  const run = sqlite.db
    .query<SqliteRunRow, [string]>("SELECT * FROM context_compile_runs WHERE id = ? LIMIT 1")
    .get(runId);
  if (!run) return null;
  const itemRows = sqlite.db
    .query<SqlitePackItemRow, [string]>(
      `SELECT item_kind, item_id, section, score, ranking_reason, source_refs, created_at
       FROM context_pack_items
       WHERE run_id = ?
       ORDER BY score DESC, created_at DESC`,
    )
    .all(runId);
  return {
    run: mapRunSummary(run),
    items: itemRows.map(mapPackItem),
  };
}

export async function getLatestCompileRunForSessionSqlite(params: {
  sessionId: string;
  createdBefore?: Date;
}): Promise<{ id: string; createdAt: Date } | null> {
  const sqlite = await getRuntimeSqliteCoreDatabase();
  const row = params.createdBefore
    ? sqlite.db
        .query<{ id: string; created_at: string }, [string, string]>(
          `SELECT id, created_at FROM context_compile_runs
           WHERE session_id = ? AND created_at <= ?
           ORDER BY created_at DESC, id DESC LIMIT 1`,
        )
        .get(params.sessionId, params.createdBefore.toISOString())
    : sqlite.db
        .query<{ id: string; created_at: string }, [string]>(
          `SELECT id, created_at FROM context_compile_runs
           WHERE session_id = ?
           ORDER BY created_at DESC, id DESC LIMIT 1`,
        )
        .get(params.sessionId);
  return row ? { id: row.id, createdAt: normalizeDate(row.created_at) } : null;
}

export async function getCompileRunByIdSqlite(runId: string): Promise<{
  id: string;
  sessionId: string | null;
  createdAt: Date;
  outputMarkdown: string | null;
} | null> {
  const sqlite = await getRuntimeSqliteCoreDatabase();
  const row = sqlite.db
    .query<SqliteRunRow, [string]>("SELECT * FROM context_compile_runs WHERE id = ? LIMIT 1")
    .get(runId);
  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.session_id,
    createdAt: normalizeDate(row.created_at),
    outputMarkdown: extractOutputMarkdown(parsePackSnapshot(row.pack_snapshot)),
  };
}

export async function listCompileRunOutputsByIdsSqlite(
  runIds: string[],
): Promise<Map<string, { createdAt: Date; goal: string; outputMarkdown: string | null }>> {
  const normalizedIds = [...new Set(runIds.map((item) => item.trim()).filter(Boolean))];
  if (normalizedIds.length === 0) return new Map();
  const sqlite = await getRuntimeSqliteCoreDatabase();
  const placeholders = normalizedIds.map(() => "?").join(", ");
  const rows = sqlite.db
    .query<SqliteRunRow, string[]>(
      `SELECT * FROM context_compile_runs WHERE id IN (${placeholders})`,
    )
    .all(...normalizedIds);
  return new Map(
    rows.map((row) => [
      row.id,
      {
        createdAt: normalizeDate(row.created_at),
        goal: row.goal,
        outputMarkdown: extractOutputMarkdown(parsePackSnapshot(row.pack_snapshot)),
      },
    ]),
  );
}

export async function getCompileFreshnessMarkersSqlite(): Promise<CompileFreshnessMarkers> {
  const sqlite = await getRuntimeSqliteCoreDatabase();
  const knowledgeRow: {
    active_updated_at?: string | null;
    draft_updated_at?: string | null;
  } =
    sqlite.db
      .query<
        {
          active_updated_at: string | null;
          draft_updated_at: string | null;
        },
        []
      >(
        `SELECT
          max(CASE WHEN status = 'active' THEN updated_at END) AS active_updated_at,
          max(CASE WHEN status = 'draft' THEN updated_at END) AS draft_updated_at
         FROM knowledge_items
         WHERE status IN ('active', 'draft')`,
      )
      .get() ?? {};
  const sourceRow: { source_updated_at?: string | null } =
    sqlite.db
      .query<{ source_updated_at: string | null }, []>(
        "SELECT max(updated_at) AS source_updated_at FROM sources",
      )
      .get() ?? {};
  return {
    knowledgeActiveUpdatedAt: normalizeIsoString(knowledgeRow.active_updated_at),
    knowledgeDraftUpdatedAt: normalizeIsoString(knowledgeRow.draft_updated_at),
    sourceCorpusUpdatedAt: normalizeIsoString(sourceRow.source_updated_at),
  };
}

export async function upsertContextCompileTaskTraceSqlite(input: {
  runId: string;
  retrievalMode: string;
  repoPath: string | null;
  repoKey: string | null;
  technologies: string[];
  changeTypes: string[];
  domains: string[];
  embeddingStatus: string;
  embeddingProvider: string | null;
  embeddingModel: string | null;
  embeddingDimensions: number | null;
  embedding: number[] | null;
  goalHash: string;
}): Promise<void> {
  const sqlite = await getRuntimeSqliteCoreDatabase();
  const now = new Date().toISOString();
  sqlite.db
    .query(
      `INSERT INTO context_compile_task_traces (
        run_id, retrieval_mode, repo_path, repo_key, technologies, change_types, domains,
        embedding_status, embedding_provider, embedding_model, embedding_dimensions,
        embedding, goal_hash, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        retrieval_mode = excluded.retrieval_mode,
        repo_path = excluded.repo_path,
        repo_key = excluded.repo_key,
        technologies = excluded.technologies,
        change_types = excluded.change_types,
        domains = excluded.domains,
        embedding_status = excluded.embedding_status,
        embedding_provider = excluded.embedding_provider,
        embedding_model = excluded.embedding_model,
        embedding_dimensions = excluded.embedding_dimensions,
        embedding = excluded.embedding,
        goal_hash = excluded.goal_hash,
        updated_at = excluded.updated_at`,
    )
    .run(
      input.runId,
      input.retrievalMode,
      input.repoPath,
      input.repoKey,
      json(input.technologies),
      json(input.changeTypes),
      json(input.domains),
      input.embeddingStatus,
      input.embeddingProvider,
      input.embeddingModel,
      input.embeddingDimensions,
      input.embedding ? json(input.embedding) : null,
      input.goalHash,
      now,
      now,
    );
}

type SqliteTaskTraceRow = {
  run_id: string;
  retrieval_mode: string;
  repo_path: string | null;
  repo_key: string | null;
  technologies: string;
  change_types: string;
  domains: string;
  embedding_status: string;
  embedding_provider: string | null;
  embedding_model: string | null;
  embedding_dimensions: number | null;
  embedding: string | null;
  goal_hash: string;
  created_at: string;
  updated_at: string;
};

function mapTaskTraceRow(row: SqliteTaskTraceRow): ContextCompileTaskTrace {
  const embeddingStatus =
    row.embedding_status === "embedding_available" ||
    row.embedding_status === "embedding_unavailable" ||
    row.embedding_status === "facets_only"
      ? row.embedding_status
      : "facets_only";
  const embedding = parseJson(row.embedding);
  return {
    runId: row.run_id,
    retrievalMode: row.retrieval_mode,
    repoPath: row.repo_path,
    repoKey: row.repo_key,
    technologies: normalizeStringArray(parseJson(row.technologies)),
    changeTypes: normalizeStringArray(parseJson(row.change_types)),
    domains: normalizeStringArray(parseJson(row.domains)),
    embeddingStatus,
    embeddingProvider: row.embedding_provider,
    embeddingModel: row.embedding_model,
    embeddingDimensions: row.embedding_dimensions,
    embedding: Array.isArray(embedding) ? embedding.map(Number).filter(Number.isFinite) : null,
    goalHash: row.goal_hash,
    createdAt: normalizeDate(row.created_at),
    updatedAt: normalizeDate(row.updated_at),
  };
}

export async function findContextCompileTaskTraceByRunIdSqlite(
  runId: string,
): Promise<ContextCompileTaskTrace | null> {
  const sqlite = await getRuntimeSqliteCoreDatabase();
  const row = sqlite.db
    .query<SqliteTaskTraceRow, [string]>(
      "SELECT * FROM context_compile_task_traces WHERE run_id = ? LIMIT 1",
    )
    .get(runId);
  return row ? mapTaskTraceRow(row) : null;
}

export async function listRecentContextCompileTaskTracesSqlite(input: {
  limit: number;
  excludeRunId?: string;
}): Promise<ContextCompileTaskTrace[]> {
  const sqlite = await getRuntimeSqliteCoreDatabase();
  const limit = Math.max(1, Math.min(400, Math.trunc(input.limit)));
  const rows = input.excludeRunId
    ? sqlite.db
        .query<SqliteTaskTraceRow, [string, number]>(
          `SELECT * FROM context_compile_task_traces
           WHERE run_id != ?
           ORDER BY created_at DESC, run_id DESC
           LIMIT ?`,
        )
        .all(input.excludeRunId, limit)
    : sqlite.db
        .query<SqliteTaskTraceRow, [number]>(
          `SELECT * FROM context_compile_task_traces
           ORDER BY created_at DESC, run_id DESC
           LIMIT ?`,
        )
        .all(limit);
  return rows.map(mapTaskTraceRow);
}

function normalizeIsoString(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function parseSqliteRunInput(row: SqliteRunRow): Record<string, unknown> {
  return asRecord(parseJson(row.input));
}
