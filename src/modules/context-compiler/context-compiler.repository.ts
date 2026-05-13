import { desc, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { contextCompileRuns, contextPackItems } from "../../db/schema.js";

export async function insertCompileRun(params: {
  goal: string;
  intent: string;
  repoPath?: string;
  input: Record<string, unknown>;
  retrievalMode: string;
  status: "ok" | "degraded" | "failed";
  degradedReasons: string[];
  tokenBudget: number;
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
    })
    .returning({ id: contextCompileRuns.id });

  return inserted.id;
}

export async function insertContextPackItems(
  runId: string,
  items: Array<{
    itemKind: string;
    itemId: string;
    section: "rules" | "skills" | "examples" | "code_context" | "warnings" | "evidence";
    score: number;
    rankingReason: string;
    evidenceRefs: string[];
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
      evidenceRefs: item.evidenceRefs,
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
  createdAt: Date;
};

export type CompileRunSnapshot = {
  run: CompileRunSummary;
  items: Array<{
    itemKind: string;
    itemId: string;
    section: string;
    score: number;
    rankingReason: string;
    evidenceRefs: string[];
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
      evidenceRefs: contextPackItems.evidenceRefs,
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
      createdAt: run.createdAt,
    },
    items: itemRows.map((row) => ({
      itemKind: row.itemKind,
      itemId: row.itemId,
      section: row.section,
      score: row.score,
      rankingReason: row.rankingReason,
      evidenceRefs: Array.isArray(row.evidenceRefs) ? (row.evidenceRefs as string[]) : [],
    })),
  };
}

export async function getLatestCompileRunSnapshot(): Promise<CompileRunSnapshot | null> {
  const rows = await listRecentCompileRuns(1);
  const latest = rows[0];
  if (!latest) return null;
  return getCompileRunSnapshot(latest.id);
}
