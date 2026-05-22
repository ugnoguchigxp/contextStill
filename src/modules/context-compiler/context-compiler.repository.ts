import { desc, eq, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  contextCompileRuns,
  contextPackItems,
  knowledgeItems,
  knowledgeUsageEvents,
  sources,
} from "../../db/schema.js";
import {
  type CompileRunDetail,
  type CompileRunSelectedItem,
  type CompileRunSource,
  compileRunDetailSchema,
  compileRunSourceSchema,
} from "../../shared/schemas/compile-run.schema.js";
import type { ContextPack } from "../../shared/schemas/context-pack.schema.js";
import { contextPackSchema } from "../../shared/schemas/context-pack.schema.js";
import { renderContextPackMarkdown } from "./pack-renderer.js";

const runStatusValues = new Set(["ok", "degraded", "failed"]);

function normalizeRunStatus(value: unknown): "ok" | "degraded" | "failed" {
  return typeof value === "string" && runStatusValues.has(value)
    ? (value as "ok" | "degraded" | "failed")
    : "failed";
}

function normalizeCompileRunSource(value: unknown): CompileRunSource {
  const parsed = compileRunSourceSchema.safeParse(value);
  return parsed.success ? parsed.data : "unknown";
}

function normalizeDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date(0);
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function normalizeDuration(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function extractOutputMarkdown(pack: ContextPack | null): string | null {
  if (!pack) return null;
  const retrievalStats = asRecord(pack.diagnostics.retrievalStats);
  const responseComposer = asRecord(retrievalStats.responseComposer);
  const fromComposer =
    typeof responseComposer.outputMarkdown === "string"
      ? responseComposer.outputMarkdown.trim()
      : "";
  if (fromComposer) return fromComposer;
  return renderContextPackMarkdown(pack);
}

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
  source?: CompileRunSource;
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
      source: params.source ?? "unknown",
    })
    .returning({ id: contextCompileRuns.id });

  return inserted.id;
}

export async function updateCompileRunSnapshot(runId: string, pack: ContextPack): Promise<void> {
  await db
    .update(contextCompileRuns)
    .set({ packSnapshot: pack as unknown as Record<string, unknown> })
    .where(eq(contextCompileRuns.id, runId));
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
  retrievalMode: string;
  status: "ok" | "degraded" | "failed";
  degradedReasons: string[];
  durationMs: number;
  source: CompileRunSource;
  createdAt: Date;
};

export type CompileFreshnessMarkers = {
  knowledgeActiveUpdatedAt: string | null;
  knowledgeDraftUpdatedAt: string | null;
  sourceCorpusUpdatedAt: string | null;
};

export type CompileRunSnapshot = {
  run: CompileRunSummary;
  items: CompileRunSelectedItem[];
};

export async function listRecentCompileRuns(limit = 20): Promise<CompileRunSummary[]> {
  const normalizedLimit = Math.min(100, Math.max(1, Math.floor(limit)));
  const rows = await db
    .select({
      id: contextCompileRuns.id,
      goal: contextCompileRuns.goal,
      retrievalMode: contextCompileRuns.retrievalMode,
      status: contextCompileRuns.status,
      degradedReasons: contextCompileRuns.degradedReasons,
      durationMs: contextCompileRuns.durationMs,
      source: contextCompileRuns.source,
      createdAt: contextCompileRuns.createdAt,
    })
    .from(contextCompileRuns)
    .orderBy(desc(contextCompileRuns.createdAt))
    .limit(normalizedLimit);

  return rows.map((row) => ({
    id: row.id,
    goal: row.goal,
    retrievalMode: row.retrievalMode,
    status: normalizeRunStatus(row.status),
    degradedReasons: normalizeStringArray(row.degradedReasons),
    durationMs: normalizeDuration(row.durationMs),
    source: normalizeCompileRunSource(row.source),
    createdAt: normalizeDate(row.createdAt),
  }));
}

export async function getCompileRunSnapshot(runId: string): Promise<CompileRunSnapshot | null> {
  const [run] = await db
    .select({
      id: contextCompileRuns.id,
      goal: contextCompileRuns.goal,
      retrievalMode: contextCompileRuns.retrievalMode,
      status: contextCompileRuns.status,
      degradedReasons: contextCompileRuns.degradedReasons,
      durationMs: contextCompileRuns.durationMs,
      source: contextCompileRuns.source,
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
      retrievalMode: run.retrievalMode,
      status: normalizeRunStatus(run.status),
      degradedReasons: normalizeStringArray(run.degradedReasons),
      durationMs: normalizeDuration(run.durationMs),
      source: normalizeCompileRunSource(run.source),
      createdAt: normalizeDate(run.createdAt),
    },
    items: itemRows.map((row) => ({
      itemKind: row.itemKind,
      itemId: row.itemId,
      section: row.section,
      score: row.score,
      rankingReason: row.rankingReason,
      sourceRefs: normalizeStringArray(row.sourceRefs),
    })),
  };
}

export async function getCompileRunDetail(runId: string): Promise<CompileRunDetail | null> {
  const [run] = await db
    .select({
      id: contextCompileRuns.id,
      goal: contextCompileRuns.goal,
      retrievalMode: contextCompileRuns.retrievalMode,
      status: contextCompileRuns.status,
      degradedReasons: contextCompileRuns.degradedReasons,
      durationMs: contextCompileRuns.durationMs,
      source: contextCompileRuns.source,
      createdAt: contextCompileRuns.createdAt,
      tokenBudget: contextCompileRuns.tokenBudget,
      input: contextCompileRuns.input,
      packSnapshot: contextCompileRuns.packSnapshot,
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

  const feedbackRows = await db
    .select({
      id: knowledgeUsageEvents.id,
      runId: knowledgeUsageEvents.runId,
      knowledgeId: knowledgeUsageEvents.knowledgeId,
      verdict: knowledgeUsageEvents.verdict,
      actor: knowledgeUsageEvents.actor,
      reason: knowledgeUsageEvents.reason,
      createdAt: knowledgeUsageEvents.createdAt,
      updatedAt: knowledgeUsageEvents.updatedAt,
    })
    .from(knowledgeUsageEvents)
    .where(eq(knowledgeUsageEvents.runId, runId))
    .orderBy(desc(knowledgeUsageEvents.updatedAt), desc(knowledgeUsageEvents.createdAt));

  const parsedPackSnapshot = contextPackSchema.safeParse(run.packSnapshot);
  const packSnapshot =
    parsedPackSnapshot.success && parsedPackSnapshot.data.runId === run.id
      ? parsedPackSnapshot.data
      : null;
  const outputMarkdown = extractOutputMarkdown(packSnapshot);
  const detail = {
    run: {
      id: run.id,
      goal: run.goal,
      retrievalMode: run.retrievalMode,
      status: normalizeRunStatus(run.status),
      degradedReasons: normalizeStringArray(run.degradedReasons),
      durationMs: normalizeDuration(run.durationMs),
      source: normalizeCompileRunSource(run.source),
      createdAt: normalizeDate(run.createdAt).toISOString(),
      tokenBudget: normalizeDuration(run.tokenBudget),
      input:
        typeof run.input === "object" && run.input !== null
          ? (run.input as Record<string, unknown>)
          : {},
    },
    pack: packSnapshot,
    outputMarkdown,
    selectedItems: itemRows.map((row) => ({
      itemKind: row.itemKind,
      itemId: row.itemId,
      section: row.section,
      score: row.score,
      rankingReason: row.rankingReason,
      sourceRefs: normalizeStringArray(row.sourceRefs),
    })),
    knowledgeFeedback: feedbackRows.map((row) => ({
      id: row.id,
      runId: row.runId,
      knowledgeId: row.knowledgeId,
      verdict:
        row.verdict === "used" || row.verdict === "off_topic" || row.verdict === "wrong"
          ? row.verdict
          : "used",
      actor:
        row.actor === "agent" || row.actor === "user" || row.actor === "system"
          ? row.actor
          : "system",
      reason: typeof row.reason === "string" ? row.reason : null,
      createdAt: normalizeDate(row.createdAt).toISOString(),
      updatedAt: normalizeDate(row.updatedAt).toISOString(),
    })),
    snapshotAvailable: packSnapshot !== null,
  };

  return compileRunDetailSchema.parse(detail);
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
