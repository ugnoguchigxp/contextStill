import { desc, eq, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { contextCompileRuns, contextPackItems, knowledgeItems, sources } from "../../db/schema.js";

export async function insertCompileRun(params: {
  goal: string;
  intent: string;
  repoPath?: string;
  input: Record<string, unknown>;
  retrievalMode: string;
  status: "ok" | "degraded" | "failed";
  degradedReasons: string[];
  tokenBudget: number;
  durationMs: number;
}): Promise<string> {
  const [inserted] = await db
    .insert(contextCompileRuns)
    .values({
      goal: params.goal,
      intent: params.intent,
      repoPath: params.repoPath ?? null,
      input: params.input,
      retrievalMode: params.retrievalMode,
      status: params.status,
      degradedReasons: params.degradedReasons,
      tokenBudget: params.tokenBudget,
      durationMs: params.durationMs,
    })
    .returning({ id: contextCompileRuns.id });

  return inserted.id;
}

export async function insertContextPackItems(
  runId: string,
  items: Array<{
    itemKind: string;
    itemId: string;
    section: "rules" | "procedures" | "code_context" | "warnings";
    score: number;
    rankingReason: string;
    sourceRefs: string[];
  }>,
): Promise<void> {
  if (items.length === 0) return;

  await db.insert(contextPackItems).values(
    items.map((item) => ({
      runId,
      itemKind: item.itemKind,
      itemId: item.itemId,
      section: item.section,
      score: item.score,
      rankingReason: item.rankingReason,
      sourceRefs: item.sourceRefs,
    })),
  );
}

export type CompileRunSummary = {
  id: string;
  goal: string;
  intent: string;
  retrievalMode: string;
  status: "ok" | "degraded" | "failed";
  degradedReasons: string[];
  durationMs: number;
  createdAt: Date;
};

export type CompileFreshnessMarkers = {
  knowledgeActiveUpdatedAt: string | null;
  knowledgeDraftUpdatedAt: string | null;
  sourceCorpusUpdatedAt: string | null;
};

export type CompileRunSnapshot = {
  run: CompileRunSummary;
  items: Array<{
    itemKind: string;
    itemId: string;
    section: string;
    score: number;
    rankingReason: string;
    sourceRefs: string[];
  }>;
};

export async function listRecentCompileRuns(limit = 20): Promise<CompileRunSummary[]> {
  const normalizedLimit = Math.min(100, Math.max(1, Math.floor(limit)));
  const rows = await db
    .select({
      id: contextCompileRuns.id,
      goal: contextCompileRuns.goal,
      intent: contextCompileRuns.intent,
      retrievalMode: contextCompileRuns.retrievalMode,
      status: contextCompileRuns.status,
      degradedReasons: contextCompileRuns.degradedReasons,
      durationMs: contextCompileRuns.durationMs,
      createdAt: contextCompileRuns.createdAt,
    })
    .from(contextCompileRuns)
    .orderBy(desc(contextCompileRuns.createdAt))
    .limit(normalizedLimit);

  return rows.map((row) => ({
    id: row.id,
    goal: row.goal,
    intent: row.intent,
    retrievalMode: row.retrievalMode,
    status: row.status as "ok" | "degraded" | "failed",
    degradedReasons: Array.isArray(row.degradedReasons) ? (row.degradedReasons as string[]) : [],
    durationMs: Number.isFinite(row.durationMs) ? Math.max(0, Math.round(row.durationMs)) : 0,
    createdAt: row.createdAt,
  }));
}

export async function getCompileRunSnapshot(runId: string): Promise<CompileRunSnapshot | null> {
  const [run] = await db
    .select({
      id: contextCompileRuns.id,
      goal: contextCompileRuns.goal,
      intent: contextCompileRuns.intent,
      retrievalMode: contextCompileRuns.retrievalMode,
      status: contextCompileRuns.status,
      degradedReasons: contextCompileRuns.degradedReasons,
      durationMs: contextCompileRuns.durationMs,
      createdAt: contextCompileRuns.createdAt,
    })
    .from(contextCompileRuns)
    .where(eq(contextCompileRuns.id, runId))
    .limit(1);

  if (!run) return null;

  const itemRows = await db
    .select({
      itemKind: contextPackItems.itemKind,
      itemId: contextPackItems.itemId,
      section: contextPackItems.section,
      score: contextPackItems.score,
      rankingReason: contextPackItems.rankingReason,
      sourceRefs: contextPackItems.sourceRefs,
    })
    .from(contextPackItems)
    .where(eq(contextPackItems.runId, runId))
    .orderBy(desc(contextPackItems.score), desc(contextPackItems.createdAt));

  return {
    run: {
      id: run.id,
      goal: run.goal,
      intent: run.intent,
      retrievalMode: run.retrievalMode,
      status: run.status as "ok" | "degraded" | "failed",
      degradedReasons: Array.isArray(run.degradedReasons) ? (run.degradedReasons as string[]) : [],
      durationMs: Number.isFinite(run.durationMs) ? Math.max(0, Math.round(run.durationMs)) : 0,
      createdAt: run.createdAt,
    },
    items: itemRows.map((row) => ({
      itemKind: row.itemKind,
      itemId: row.itemId,
      section: row.section,
      score: row.score,
      rankingReason: row.rankingReason,
      sourceRefs: Array.isArray(row.sourceRefs) ? (row.sourceRefs as string[]) : [],
    })),
  };
}

export async function getLatestCompileRunSnapshot(): Promise<CompileRunSnapshot | null> {
  const rows = await listRecentCompileRuns(1);
  const latest = rows[0];
  if (!latest) return null;
  return getCompileRunSnapshot(latest.id);
}

function toIsoTimestamp(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

export async function getCompileFreshnessMarkers(params?: {
  repoPath?: string;
  repoKey?: string;
}): Promise<CompileFreshnessMarkers> {
  const repoPath = params?.repoPath?.trim() ? params.repoPath.trim() : undefined;
  const repoKey = params?.repoKey?.trim() ? params.repoKey.trim().toLowerCase() : undefined;

  const knowledgeResult =
    repoPath || repoKey
      ? await db.execute(sql`
          select
            max(case when ${knowledgeItems.status} = 'active' then ${knowledgeItems.updatedAt} end) as active_updated_at,
            max(case when ${knowledgeItems.status} = 'draft' then ${knowledgeItems.updatedAt} end) as draft_updated_at
          from ${knowledgeItems}
          where ${knowledgeItems.status} in ('active', 'draft')
            and (
              ${knowledgeItems.scope} = 'global'
              ${repoKey ? sql`or ${knowledgeItems.appliesTo} ->> 'repoKey' = ${repoKey}` : sql``}
              ${repoPath ? sql`or ${knowledgeItems.appliesTo} ->> 'repoPath' = ${repoPath}` : sql``}
            )
        `)
      : await db.execute(sql`
          select
            max(case when ${knowledgeItems.status} = 'active' then ${knowledgeItems.updatedAt} end) as active_updated_at,
            max(case when ${knowledgeItems.status} = 'draft' then ${knowledgeItems.updatedAt} end) as draft_updated_at
          from ${knowledgeItems}
          where ${knowledgeItems.status} in ('active', 'draft')
        `);

  const sourceResult = await db.execute(sql`
    select max(${sources.updatedAt}) as source_updated_at
    from ${sources}
  `);

  const knowledgeRow = (knowledgeResult.rows as Array<Record<string, unknown>>)[0] ?? {};
  const sourceRow = (sourceResult.rows as Array<Record<string, unknown>>)[0] ?? {};

  return {
    knowledgeActiveUpdatedAt: toIsoTimestamp(knowledgeRow.active_updated_at),
    knowledgeDraftUpdatedAt: toIsoTimestamp(knowledgeRow.draft_updated_at),
    sourceCorpusUpdatedAt: toIsoTimestamp(sourceRow.source_updated_at),
  };
}
