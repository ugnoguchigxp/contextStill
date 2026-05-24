import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { contextCompileRuns, contextPackItems, knowledgeUsageEvents } from "../../db/schema.js";
import type {
  LandscapeFeedbackActor,
  LandscapeRunStatus,
  LandscapeRunStatusFilter,
  LandscapeUsageVerdict,
} from "./landscape-replay.types.js";

export type LandscapeReplayCompileRunRow = {
  id: string;
  goal: string;
  intent: string;
  repoPath: string | null;
  input: Record<string, unknown>;
  retrievalMode: string;
  status: LandscapeRunStatus;
  degradedReasons: unknown;
  source: string;
  packSnapshot: unknown;
  createdAt: Date;
};

export type LandscapeReplayPackItemRow = {
  runId: string;
  itemKind: string;
  itemId: string;
  score: number;
  rankingReason: string;
  sourceRefs: unknown;
  createdAt: Date;
};

export type LandscapeReplayUsageEventRow = {
  runId: string;
  knowledgeId: string;
  verdict: LandscapeUsageVerdict;
  actor: LandscapeFeedbackActor;
  reason: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
};

export type LandscapeReplayCorpusRows = {
  runs: LandscapeReplayCompileRunRow[];
  packItems: LandscapeReplayPackItemRow[];
  usageEvents: LandscapeReplayUsageEventRow[];
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeRunStatus(value: string): LandscapeRunStatus {
  if (value === "degraded" || value === "failed") return value;
  return "ok";
}

function normalizeVerdict(value: string): LandscapeUsageVerdict {
  if (value === "not_used" || value === "off_topic" || value === "wrong") return value;
  return "used";
}

function normalizeActor(value: string): LandscapeFeedbackActor {
  if (value === "user" || value === "system") return value;
  return "agent";
}

export async function loadLandscapeReplayCorpus(params: {
  windowDays: number;
  limit: number;
  runStatus: LandscapeRunStatusFilter;
}): Promise<LandscapeReplayCorpusRows> {
  const conditions = [
    sql`${contextCompileRuns.createdAt} >= now() - (${params.windowDays} * interval '1 day')`,
  ];
  if (params.runStatus !== "all") {
    conditions.push(eq(contextCompileRuns.status, params.runStatus));
  }

  const runs = await db
    .select({
      id: contextCompileRuns.id,
      goal: contextCompileRuns.goal,
      intent: contextCompileRuns.intent,
      repoPath: contextCompileRuns.repoPath,
      input: contextCompileRuns.input,
      retrievalMode: contextCompileRuns.retrievalMode,
      status: contextCompileRuns.status,
      degradedReasons: contextCompileRuns.degradedReasons,
      source: contextCompileRuns.source,
      packSnapshot: contextCompileRuns.packSnapshot,
      createdAt: contextCompileRuns.createdAt,
    })
    .from(contextCompileRuns)
    .where(and(...conditions))
    .orderBy(desc(contextCompileRuns.createdAt))
    .limit(params.limit);

  const runIds = runs.map((run) => run.id);
  if (runIds.length === 0) {
    return { runs: [], packItems: [], usageEvents: [] };
  }

  const [packItems, usageEvents] = await Promise.all([
    db
      .select({
        runId: contextPackItems.runId,
        itemKind: contextPackItems.itemKind,
        itemId: contextPackItems.itemId,
        score: contextPackItems.score,
        rankingReason: contextPackItems.rankingReason,
        sourceRefs: contextPackItems.sourceRefs,
        createdAt: contextPackItems.createdAt,
      })
      .from(contextPackItems)
      .where(
        and(
          inArray(contextPackItems.runId, runIds),
          inArray(contextPackItems.itemKind, ["rule", "procedure"]),
        ),
      )
      .orderBy(desc(contextPackItems.score), desc(contextPackItems.createdAt)),
    db
      .select({
        runId: knowledgeUsageEvents.runId,
        knowledgeId: knowledgeUsageEvents.knowledgeId,
        verdict: knowledgeUsageEvents.verdict,
        actor: knowledgeUsageEvents.actor,
        reason: knowledgeUsageEvents.reason,
        metadata: knowledgeUsageEvents.metadata,
        createdAt: knowledgeUsageEvents.createdAt,
        updatedAt: knowledgeUsageEvents.updatedAt,
      })
      .from(knowledgeUsageEvents)
      .where(inArray(knowledgeUsageEvents.runId, runIds))
      .orderBy(desc(knowledgeUsageEvents.updatedAt), desc(knowledgeUsageEvents.createdAt)),
  ]);

  return {
    runs: runs.map((run) => ({
      id: run.id,
      goal: run.goal,
      intent: run.intent,
      repoPath: run.repoPath,
      input: asRecord(run.input),
      retrievalMode: run.retrievalMode,
      status: normalizeRunStatus(run.status),
      degradedReasons: run.degradedReasons,
      source: run.source,
      packSnapshot: run.packSnapshot,
      createdAt: run.createdAt,
    })),
    packItems: packItems.map((item) => ({
      runId: item.runId,
      itemKind: item.itemKind,
      itemId: item.itemId,
      score: asNumber(item.score, 0),
      rankingReason: item.rankingReason,
      sourceRefs: item.sourceRefs,
      createdAt: item.createdAt,
    })),
    usageEvents: usageEvents.map((event) => ({
      runId: event.runId,
      knowledgeId: event.knowledgeId,
      verdict: normalizeVerdict(event.verdict),
      actor: normalizeActor(event.actor),
      reason: event.reason,
      metadata: asRecord(event.metadata),
      createdAt: event.createdAt,
      updatedAt: event.updatedAt,
    })),
  };
}
