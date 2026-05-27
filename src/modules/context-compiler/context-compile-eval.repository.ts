import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { contextCompileEvals, contextCompileRuns, sessionMemos } from "../../db/schema.js";

export type CompileEvalRecord = {
  id: string;
  runId: string;
  sessionId: string | null;
  score: number;
  outcome: "useful" | "partial" | "misleading" | "unused";
  title: string | null;
  body: string;
  source: "mcp" | "ui" | "system" | "import";
  createdAt: Date;
  updatedAt: Date;
};

export type CompileEvalSummary = {
  count: number;
  latestScore: number | null;
  averageScore: number | null;
  latestOutcome: "useful" | "partial" | "misleading" | "unused" | null;
  latestEvaluatedAt: string | null;
};

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

function toIso(value: Date): string {
  return value.toISOString();
}

function asRows<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export async function insertCompileEval(params: {
  runId: string;
  sessionId?: string | null;
  score: number;
  outcome: CompileEvalRecord["outcome"];
  title?: string;
  body: string;
  source?: CompileEvalRecord["source"];
  metadata?: Record<string, unknown>;
}): Promise<CompileEvalRecord> {
  const [row] = await db
    .insert(contextCompileEvals)
    .values({
      runId: params.runId,
      sessionId: params.sessionId ?? null,
      score: params.score,
      outcome: params.outcome,
      title: params.title ?? null,
      body: params.body,
      source: params.source ?? "mcp",
      metadata: params.metadata ?? {},
      updatedAt: new Date(),
    })
    .returning();
  return {
    id: row.id,
    runId: row.runId,
    sessionId: row.sessionId,
    score: row.score,
    outcome: normalizeOutcome(row.outcome),
    title: row.title,
    body: row.body,
    source: normalizeSource(row.source),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getCompileEvalSummaryByRunId(runId: string): Promise<CompileEvalSummary> {
  const aggRows = asRows<{ count: number; averageScore: number | null }>(
    await db
      .select({
        count: sql<number>`count(*)::int`,
        averageScore: sql<
          number | null
        >`round(avg(${contextCompileEvals.score})::numeric, 1)::float8`,
      })
      .from(contextCompileEvals)
      .where(eq(contextCompileEvals.runId, runId)),
  );
  const aggRow = aggRows[0];

  const latestRows = asRows<{ score: number; outcome: string; createdAt: Date }>(
    await db
      .select({
        score: contextCompileEvals.score,
        outcome: contextCompileEvals.outcome,
        createdAt: contextCompileEvals.createdAt,
      })
      .from(contextCompileEvals)
      .where(eq(contextCompileEvals.runId, runId))
      .orderBy(desc(contextCompileEvals.createdAt), desc(contextCompileEvals.id))
      .limit(1),
  );
  const latestRow = latestRows[0];

  return {
    count: aggRow?.count ?? 0,
    latestScore: latestRow?.score ?? null,
    averageScore: aggRow?.averageScore ?? null,
    latestOutcome:
      latestRow &&
      (latestRow.outcome === "useful" ||
        latestRow.outcome === "partial" ||
        latestRow.outcome === "misleading" ||
        latestRow.outcome === "unused")
        ? latestRow.outcome
        : null,
    latestEvaluatedAt: latestRow?.createdAt ? toIso(latestRow.createdAt) : null,
  };
}

export async function listCompileEvalsByRunId(runId: string): Promise<CompileEvalRecord[]> {
  const rows = asRows<
    typeof contextCompileEvals.$inferSelect & {
      outcome: unknown;
      source: unknown;
    }
  >(
    await db
      .select()
      .from(contextCompileEvals)
      .where(eq(contextCompileEvals.runId, runId))
      .orderBy(desc(contextCompileEvals.createdAt), desc(contextCompileEvals.id)),
  );
  return rows.map((row) => ({
    id: row.id,
    runId: row.runId,
    sessionId: row.sessionId,
    score: row.score,
    outcome: normalizeOutcome(row.outcome),
    title: row.title,
    body: row.body,
    source: normalizeSource(row.source),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

export async function findRunIdForCompileEval(params: {
  sessionId: string;
}): Promise<{
  runId: string;
  resolvedFrom: "latest_session_compile_result" | "latest_session_run";
} | null> {
  const memoRows = asRows<{ runId: string | null }>(
    await db
      .select({
        runId: sql<string | null>`${sessionMemos.metadata} ->> 'contextCompileRunId'`,
      })
      .from(sessionMemos)
      .where(
        and(
          eq(sessionMemos.sessionId, params.sessionId),
          eq(sessionMemos.kind, "compile_result"),
          isNull(sessionMemos.deletedAt),
        ),
      )
      .orderBy(desc(sessionMemos.updatedAt), desc(sessionMemos.createdAt))
      .limit(1),
  );
  const memoRow = memoRows[0];
  const runIdFromMemo = memoRow?.runId?.trim();
  if (runIdFromMemo) {
    const [runExists] = await db
      .select({ id: contextCompileRuns.id })
      .from(contextCompileRuns)
      .where(eq(contextCompileRuns.id, runIdFromMemo))
      .limit(1);
    if (runExists) {
      return { runId: runIdFromMemo, resolvedFrom: "latest_session_compile_result" };
    }
  }

  const [runRow] = await db
    .select({ id: contextCompileRuns.id })
    .from(contextCompileRuns)
    .where(
      and(
        eq(contextCompileRuns.sessionId, params.sessionId),
        isNotNull(contextCompileRuns.sessionId),
      ),
    )
    .orderBy(desc(contextCompileRuns.createdAt), desc(contextCompileRuns.id))
    .limit(1);
  if (!runRow) return null;
  return { runId: runRow.id, resolvedFrom: "latest_session_run" };
}

export async function getCompileRunSessionId(
  runId: string,
): Promise<{ id: string; sessionId: string | null } | null> {
  const [row] = await db
    .select({ id: contextCompileRuns.id, sessionId: contextCompileRuns.sessionId })
    .from(contextCompileRuns)
    .where(eq(contextCompileRuns.id, runId))
    .limit(1);
  return row ?? null;
}
