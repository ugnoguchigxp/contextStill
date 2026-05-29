import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  contextCompileCandidateTraces,
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
} from "../../shared/schemas/compile-run.schema.js";
import type { ContextPack } from "../../shared/schemas/context-pack.schema.js";
import { contextPackSchema } from "../../shared/schemas/context-pack.schema.js";
import { asRecord, asStringArray, normalizeNullableString } from "../../shared/utils/normalize.js";
import {
  getCompileEvalSummaryByRunId,
  listCompileEvalsByRunId,
} from "./context-compile-eval.repository.js";
import {
  extractCompileRunSignals,
  extractOutputMarkdown,
  feedbackActorValues,
  knowledgeVerdictValues,
  normalizeCompileRunSource,
  normalizeDate,
  normalizeDuration,
  normalizeFeedbackActor,
  normalizeKnowledgeVerdict,
  normalizeRunStatus,
  normalizeStringArray,
} from "./context-compiler.repository.utils.js";

export async function insertCompileRun(params: {
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
  source?: CompileRunSource;
}): Promise<string> {
  const [inserted] = await db
    .insert(contextCompileRuns)
    .values({
      goal: params.goal,
      intent: params.intent,
      sessionId: params.sessionId ?? null,
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

export async function insertContextCompileCandidateTraces(
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

  await db.insert(contextCompileCandidateTraces).values(
    items.map((item) => ({
      runId,
      itemKind: item.itemKind,
      itemId: item.itemId,
      textRank: item.textRank,
      textScore: item.textScore,
      vectorRank: item.vectorRank,
      vectorScore: item.vectorScore,
      mergedRank: item.mergedRank,
      mergedScore: item.mergedScore,
      finalRank: item.finalRank,
      finalScore: item.finalScore,
      selected: item.selected,
      suppressed: item.suppressed,
      suppressionReason: item.suppressionReason,
      agenticDecision: item.agenticDecision,
      rankingReason: item.rankingReason,
      communityKey: item.communityKey,
      evidence: item.evidence,
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
  evalSummary: {
    count: number;
    latestAvg: number | null;
    averageAvg: number | null;
    latestOutcome: "useful" | "partial" | "misleading" | "unused" | null;
    latestEvaluatedAt: string | null;
  };
  selectedItemCount: number;
  outputMarkdownKind: "narrative" | "no-content" | null;
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
      packSnapshot: contextCompileRuns.packSnapshot,
      createdAt: contextCompileRuns.createdAt,
    })
    .from(contextCompileRuns)
    .orderBy(desc(contextCompileRuns.createdAt))
    .limit(normalizedLimit);

  return Promise.all(
    rows.map(async (row) => {
      const signals = extractCompileRunSignals(row.packSnapshot);
      const evalSummary = await getCompileEvalSummaryByRunId(row.id);
      return {
        id: row.id,
        goal: row.goal,
        retrievalMode: row.retrievalMode,
        status: normalizeRunStatus(row.status),
        degradedReasons: normalizeStringArray(row.degradedReasons),
        durationMs: normalizeDuration(row.durationMs),
        source: normalizeCompileRunSource(row.source),
        evalSummary,
        selectedItemCount: signals.selectedItemCount,
        outputMarkdownKind: signals.outputMarkdownKind,
        createdAt: normalizeDate(row.createdAt),
      };
    }),
  );
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
      packSnapshot: contextCompileRuns.packSnapshot,
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

  const signals = extractCompileRunSignals(run.packSnapshot);
  return {
    run: {
      id: run.id,
      goal: run.goal,
      retrievalMode: run.retrievalMode,
      status: normalizeRunStatus(run.status),
      degradedReasons: normalizeStringArray(run.degradedReasons),
      durationMs: normalizeDuration(run.durationMs),
      source: normalizeCompileRunSource(run.source),
      evalSummary: await getCompileEvalSummaryByRunId(run.id),
      selectedItemCount: signals.selectedItemCount,
      outputMarkdownKind: signals.outputMarkdownKind,
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

export async function getLatestCompileRunForSession(params: {
  sessionId: string;
  createdBefore?: Date;
}): Promise<{ id: string; createdAt: Date } | null> {
  const [row] = await db
    .select({
      id: contextCompileRuns.id,
      createdAt: contextCompileRuns.createdAt,
    })
    .from(contextCompileRuns)
    .where(
      and(
        eq(contextCompileRuns.sessionId, params.sessionId),
        params.createdBefore ? lte(contextCompileRuns.createdAt, params.createdBefore) : undefined,
      ),
    )
    .orderBy(desc(contextCompileRuns.createdAt))
    .limit(1);
  if (!row) return null;
  return { id: row.id, createdAt: normalizeDate(row.createdAt) };
}

function resolveOutputMarkdownFromPackSnapshot(packSnapshot: unknown): string | null {
  const parsed = contextPackSchema.safeParse(packSnapshot);
  if (!parsed.success) return null;
  return extractOutputMarkdown(parsed.data);
}

export async function getCompileRunById(runId: string): Promise<{
  id: string;
  sessionId: string | null;
  createdAt: Date;
  outputMarkdown: string | null;
} | null> {
  const [row] = await db
    .select({
      id: contextCompileRuns.id,
      sessionId: contextCompileRuns.sessionId,
      createdAt: contextCompileRuns.createdAt,
      packSnapshot: contextCompileRuns.packSnapshot,
    })
    .from(contextCompileRuns)
    .where(eq(contextCompileRuns.id, runId))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    sessionId: normalizeNullableString(row.sessionId),
    createdAt: normalizeDate(row.createdAt),
    outputMarkdown: resolveOutputMarkdownFromPackSnapshot(row.packSnapshot),
  };
}

export async function listCompileRunOutputsByIds(runIds: string[]): Promise<
  Map<
    string,
    {
      createdAt: Date;
      goal: string;
      outputMarkdown: string | null;
    }
  >
> {
  const normalizedIds = [...new Set(runIds.map((item) => item.trim()).filter(Boolean))];
  if (normalizedIds.length === 0) return new Map();
  const rows = await db
    .select({
      id: contextCompileRuns.id,
      createdAt: contextCompileRuns.createdAt,
      goal: contextCompileRuns.goal,
      packSnapshot: contextCompileRuns.packSnapshot,
    })
    .from(contextCompileRuns)
    .where(inArray(contextCompileRuns.id, normalizedIds));

  return new Map(
    rows.map((row) => [
      row.id,
      {
        createdAt: normalizeDate(row.createdAt),
        goal: row.goal,
        outputMarkdown: resolveOutputMarkdownFromPackSnapshot(row.packSnapshot),
      },
    ]),
  );
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
      metadata: knowledgeUsageEvents.metadata,
      createdAt: knowledgeUsageEvents.createdAt,
      updatedAt: knowledgeUsageEvents.updatedAt,
    })
    .from(knowledgeUsageEvents)
    .where(eq(knowledgeUsageEvents.runId, runId))
    .orderBy(desc(knowledgeUsageEvents.updatedAt), desc(knowledgeUsageEvents.createdAt));
  const evalRows = await listCompileEvalsByRunId(runId);

  const parsedPackSnapshot = contextPackSchema.safeParse(run.packSnapshot);
  const packSnapshot =
    parsedPackSnapshot.success && parsedPackSnapshot.data.runId === run.id
      ? parsedPackSnapshot.data
      : null;

  if (packSnapshot) {
    const allItemIds = [
      ...(packSnapshot.rules ?? []).map((item) => item.itemId),
      ...(packSnapshot.procedures ?? []).map((item) => item.itemId),
    ].filter(Boolean);

    const knowledgeRows = allItemIds.length > 0
      ? await db
          .select({
            id: knowledgeItems.id,
            appliesTo: knowledgeItems.appliesTo,
          })
          .from(knowledgeItems)
          .where(inArray(knowledgeItems.id, allItemIds))
      : [];

    const appliesToByItemId = new Map<string, { changeTypes: string[]; technologies: string[]; domains: string[] }>();
    for (const row of knowledgeRows) {
      const appliesTo = asRecord(row.appliesTo);
      appliesToByItemId.set(row.id, {
        changeTypes: asStringArray(appliesTo.changeTypes),
        technologies: asStringArray(appliesTo.technologies),
        domains: asStringArray(appliesTo.domains),
      });
    }

    for (const item of packSnapshot.rules) {
      const applies = appliesToByItemId.get(item.itemId);
      item.changeTypes = item.changeTypes?.length ? item.changeTypes : (applies?.changeTypes ?? []);
      item.technologies = item.technologies?.length ? item.technologies : (applies?.technologies ?? []);
      item.domains = item.domains?.length ? item.domains : (applies?.domains ?? []);
    }

    for (const item of packSnapshot.procedures) {
      const applies = appliesToByItemId.get(item.itemId);
      item.changeTypes = item.changeTypes?.length ? item.changeTypes : (applies?.changeTypes ?? []);
      item.technologies = item.technologies?.length ? item.technologies : (applies?.technologies ?? []);
      item.domains = item.domains?.length ? item.domains : (applies?.domains ?? []);
    }
  }

  const outputMarkdown = extractOutputMarkdown(packSnapshot);

  const selectedKnowledgeRowsMap = new Map<
    string,
    {
      knowledgeId: string;
      itemKind: "rule" | "procedure";
      section: "rules" | "procedures";
      score: number;
      rankingReason: string;
    }
  >();
  for (const row of itemRows) {
    if (row.itemKind !== "rule" && row.itemKind !== "procedure") continue;
    if (selectedKnowledgeRowsMap.has(row.itemId)) continue;
    selectedKnowledgeRowsMap.set(row.itemId, {
      knowledgeId: row.itemId,
      itemKind: row.itemKind,
      section: row.section === "procedures" ? "procedures" : "rules",
      score: row.score,
      rankingReason: row.rankingReason,
    });
  }
  const selectedKnowledgeRows = [...selectedKnowledgeRowsMap.values()];

  const packTitleById = new Map<string, string>();
  for (const item of [...(packSnapshot?.rules ?? []), ...(packSnapshot?.procedures ?? [])]) {
    if (item.itemKind !== "rule" && item.itemKind !== "procedure") continue;
    packTitleById.set(item.itemId, item.title);
  }

  const latestFeedbackByKnowledgeId = new Map<
    string,
    {
      verdict: "used" | "not_used" | "off_topic" | "wrong";
      actor: "agent" | "user" | "system";
      reason: string | null;
      metadata: Record<string, unknown>;
      updatedAt: string | null;
    }
  >();
  for (const row of feedbackRows) {
    if (latestFeedbackByKnowledgeId.has(row.knowledgeId)) continue;
    latestFeedbackByKnowledgeId.set(row.knowledgeId, {
      verdict: normalizeKnowledgeVerdict(row.verdict),
      actor: normalizeFeedbackActor(row.actor),
      reason: normalizeNullableString(row.reason),
      metadata: asRecord(row.metadata),
      updatedAt: row.updatedAt ? normalizeDate(row.updatedAt).toISOString() : null,
    });
  }

  const detail = {
    run: {
      id: run.id,
      goal: run.goal,
      retrievalMode: run.retrievalMode,
      status: normalizeRunStatus(run.status),
      degradedReasons: normalizeStringArray(run.degradedReasons),
      durationMs: normalizeDuration(run.durationMs),
      source: normalizeCompileRunSource(run.source),
      evalSummary: await getCompileEvalSummaryByRunId(run.id),
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
      verdict: normalizeKnowledgeVerdict(row.verdict),
      actor: normalizeFeedbackActor(row.actor),
      reason: normalizeNullableString(row.reason),
      createdAt: normalizeDate(row.createdAt).toISOString(),
      updatedAt: normalizeDate(row.updatedAt).toISOString(),
    })),
    knowledgeSignals: selectedKnowledgeRows.map((row) => {
      const latestFeedback = latestFeedbackByKnowledgeId.get(row.knowledgeId);
      const metadata = asRecord(latestFeedback?.metadata);
      const autoVerdict = normalizeKnowledgeVerdict(metadata.autoVerdict);
      const autoVerdictPresent = knowledgeVerdictValues.has(String(metadata.autoVerdict));
      const autoActor = normalizeFeedbackActor(metadata.autoActor);
      const autoActorPresent = feedbackActorValues.has(String(metadata.autoActor));

      if (!latestFeedback) {
        return {
          knowledgeId: row.knowledgeId,
          rawId: row.knowledgeId,
          itemKind: row.itemKind,
          section: row.section,
          title: packTitleById.get(row.knowledgeId) ?? `Knowledge ${row.knowledgeId.slice(0, 8)}`,
          score: row.score,
          rankingReason: row.rankingReason,
          autoVerdict: null,
          autoActor: null,
          autoReason: null,
          effectiveVerdict: null,
          effectiveActor: null,
          effectiveReason: null,
          hasUserOverride: false,
          updatedAt: null,
        };
      }

      const effectiveVerdict = latestFeedback.verdict;
      const effectiveActor = latestFeedback.actor;
      const effectiveReason = latestFeedback.reason;

      if (effectiveActor === "user") {
        const resolvedAutoVerdict = autoVerdictPresent ? autoVerdict : null;
        const resolvedAutoActor = autoActorPresent ? autoActor : null;
        const resolvedAutoReason = normalizeNullableString(metadata.autoReason);
        const hasUserOverride =
          resolvedAutoVerdict !== null && resolvedAutoVerdict !== effectiveVerdict;
        return {
          knowledgeId: row.knowledgeId,
          rawId: row.knowledgeId,
          itemKind: row.itemKind,
          section: row.section,
          title: packTitleById.get(row.knowledgeId) ?? `Knowledge ${row.knowledgeId.slice(0, 8)}`,
          score: row.score,
          rankingReason: row.rankingReason,
          autoVerdict: resolvedAutoVerdict,
          autoActor: resolvedAutoActor,
          autoReason: resolvedAutoReason,
          effectiveVerdict,
          effectiveActor,
          effectiveReason,
          hasUserOverride,
          updatedAt: latestFeedback.updatedAt,
        };
      }

      return {
        knowledgeId: row.knowledgeId,
        rawId: row.knowledgeId,
        itemKind: row.itemKind,
        section: row.section,
        title: packTitleById.get(row.knowledgeId) ?? `Knowledge ${row.knowledgeId.slice(0, 8)}`,
        score: row.score,
        rankingReason: row.rankingReason,
        autoVerdict: effectiveVerdict,
        autoActor: effectiveActor,
        autoReason: effectiveReason,
        effectiveVerdict,
        effectiveActor,
        effectiveReason,
        hasUserOverride: false,
        updatedAt: latestFeedback.updatedAt,
      };
    }),
    evaluations: evalRows.map((row) => ({
      id: row.id,
      runId: row.runId,
      sessionId: row.sessionId,
      avg: row.avg,
      outcome: row.outcome,
      title: row.title,
      body: row.body,
      source: row.source,
      relevance: row.relevance,
      actionability: row.actionability,
      coverage: row.coverage,
      noise: row.noise,
      specificity: row.specificity,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
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
