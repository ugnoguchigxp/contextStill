import { randomUUID } from "node:crypto";
import type { CompileEvalRecord, CompileEvalSummary } from "./context-compile-eval.repository.js";
import { normalizeDate } from "./context-compiler.repository.utils.js";

type SqliteCompileEvalRow = {
  id: string;
  run_id: string;
  session_id: string | null;
  score: number;
  outcome: string;
  title: string | null;
  body: string;
  source: string;
  metadata: string;
  relevance: number | null;
  actionability: number | null;
  coverage: number | null;
  clarity: number | null;
  specificity: number | null;
  created_at: string;
  updated_at: string;
};

async function getSqliteCoreDatabase() {
  const { getRuntimeSqliteCoreDatabase } = await import("../../db/sqlite/runtime.js");
  return getRuntimeSqliteCoreDatabase();
}

function normalizeOutcome(value: unknown): CompileEvalRecord["outcome"] {
  if (value === "useful" || value === "partial" || value === "misleading" || value === "unused") {
    return value;
  }
  throw new Error(`Invalid compile eval outcome: ${String(value)}`);
}

function normalizeSource(value: unknown): CompileEvalRecord["source"] {
  if (value === "mcp" || value === "ui" || value === "system" || value === "import") return value;
  return "mcp";
}

function toDate(value: string): Date {
  return normalizeDate(value);
}

function mapRow(row: SqliteCompileEvalRow): CompileEvalRecord {
  return {
    id: row.id,
    runId: row.run_id,
    sessionId: row.session_id,
    avg: row.score,
    outcome: normalizeOutcome(row.outcome),
    title: row.title,
    body: row.body,
    source: normalizeSource(row.source),
    relevance: row.relevance,
    actionability: row.actionability,
    coverage: row.coverage,
    clarity: row.clarity,
    specificity: row.specificity,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

export async function insertCompileEvalSqlite(params: {
  runId: string;
  sessionId?: string | null;
  avg: number;
  outcome: CompileEvalRecord["outcome"];
  title?: string;
  body: string;
  source?: CompileEvalRecord["source"];
  metadata?: Record<string, unknown>;
  relevance: number;
  actionability: number;
  coverage: number;
  clarity: number;
  specificity: number;
}): Promise<CompileEvalRecord> {
  const sqlite = await getSqliteCoreDatabase();
  const id = randomUUID();
  const now = new Date().toISOString();
  sqlite.db
    .query(
      `INSERT INTO context_compile_evals (
        id, run_id, session_id, score, outcome, title, body, source, metadata,
        relevance, actionability, coverage, clarity, specificity, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      params.runId,
      params.sessionId ?? null,
      Math.max(0, Math.min(100, Math.trunc(params.avg))),
      params.outcome,
      params.title ?? null,
      params.body,
      params.source ?? "mcp",
      JSON.stringify(params.metadata ?? {}),
      params.relevance,
      params.actionability,
      params.coverage,
      params.clarity,
      params.specificity,
      now,
      now,
    );
  const row = sqlite.db
    .query<SqliteCompileEvalRow, [string]>(
      "SELECT * FROM context_compile_evals WHERE id = ? LIMIT 1",
    )
    .get(id);
  if (!row) throw new Error(`failed to insert compile eval: ${id}`);
  return mapRow(row);
}

export async function getCompileEvalSummaryByRunIdSqlite(
  runId: string,
): Promise<CompileEvalSummary> {
  const sqlite = await getSqliteCoreDatabase();
  const agg = sqlite.db
    .query<{ count: number; average_avg: number | null }, [string]>(
      "SELECT count(*) AS count, round(avg(score), 1) AS average_avg FROM context_compile_evals WHERE run_id = ?",
    )
    .get(runId) ?? { count: 0, average_avg: null };
  const latest = sqlite.db
    .query<Pick<SqliteCompileEvalRow, "score" | "outcome" | "created_at">, [string]>(
      `SELECT score, outcome, created_at FROM context_compile_evals
       WHERE run_id = ?
       ORDER BY created_at DESC, _rowid_ DESC
       LIMIT 1`,
    )
    .get(runId);
  const latestOutcome = latest ? normalizeOutcome(latest.outcome) : null;
  return {
    count: Number(agg.count ?? 0),
    latestAvg: latest?.score ?? null,
    averageAvg: agg.average_avg,
    latestOutcome,
    latestEvaluatedAt: latest?.created_at ? toDate(latest.created_at).toISOString() : null,
  };
}

export async function listCompileEvalsByRunIdSqlite(runId: string): Promise<CompileEvalRecord[]> {
  const sqlite = await getSqliteCoreDatabase();
  const rows = sqlite.db
    .query<SqliteCompileEvalRow, [string]>(
      `SELECT * FROM context_compile_evals
       WHERE run_id = ?
       ORDER BY created_at DESC, _rowid_ DESC`,
    )
    .all(runId);
  return rows.map(mapRow);
}

export async function findRunIdForCompileEvalSqlite(params: {
  sessionId: string;
}): Promise<{ runId: string; resolvedFrom: "latest_session_run" } | null> {
  const sqlite = await getSqliteCoreDatabase();
  const row = sqlite.db
    .query<{ id: string }, [string]>(
      `SELECT id FROM context_compile_runs
       WHERE session_id = ?
       ORDER BY created_at DESC, _rowid_ DESC
       LIMIT 1`,
    )
    .get(params.sessionId);
  return row ? { runId: row.id, resolvedFrom: "latest_session_run" } : null;
}

export async function getCompileRunSessionIdSqlite(
  runId: string,
): Promise<{ id: string; sessionId: string | null } | null> {
  const sqlite = await getSqliteCoreDatabase();
  const row = sqlite.db
    .query<{ id: string; session_id: string | null }, [string]>(
      "SELECT id, session_id FROM context_compile_runs WHERE id = ? LIMIT 1",
    )
    .get(runId);
  return row ? { id: row.id, sessionId: row.session_id } : null;
}
