import { sql } from "drizzle-orm";
import { resolveDatabaseBackendConfig } from "../../db/backend.js";
import { db } from "../../db/index.js";
import type { LandscapeCommunity, LandscapeSnapshot } from "../landscape/landscape.types.js";
import {
  type DecisionSignalBundle,
  type DecisionSignalLoadResult,
  emptyDecisionSignalBundle,
} from "./context-decision.signals.js";

type CompileSignalRow = {
  knowledge_id?: string;
  compile_select_count?: number | string;
  recent_selected_count?: number | string;
  used_count?: number | string;
  not_used_count?: number | string;
  off_topic_count?: number | string;
  wrong_count?: number | string;
  suppressed_count?: number | string;
  rejected_by_agentic_count?: number | string;
  misleading_eval_count?: number | string;
};

type CommunitySignalRow = {
  knowledge_id?: string;
  community_key?: string | null;
  community_label?: string | null;
  compile_select_count?: number | string;
};

function uniqueIds(ids: string[]): string[] {
  return Array.from(new Set(ids.filter(Boolean)));
}

function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function asLandscapeSnapshot(value: unknown): LandscapeSnapshot | null {
  const record = parseJsonRecord(value);
  return Array.isArray(record.communities) ? (record as unknown as LandscapeSnapshot) : null;
}

function landscapeByCommunityKey(
  snapshot: LandscapeSnapshot | null,
): Map<string, LandscapeCommunity> {
  if (!snapshot) return new Map();
  return new Map(snapshot.communities.map((community) => [community.communityKey, community]));
}

function applyLandscapeSignals(
  bundles: Map<string, DecisionSignalBundle>,
  landscape: LandscapeSnapshot | null,
): void {
  const communities = landscapeByCommunityKey(landscape);
  if (communities.size === 0) return;

  for (const [, bundle] of bundles) {
    const communityKey = bundle.community?.communityKey;
    if (!communityKey) continue;
    const community = communities.get(communityKey);
    if (!community) continue;
    bundle.community = {
      communityKey,
      communityLabel: community.communityLabel,
      communityRank: community.communityRank,
      sourceRefDensity: community.quality.sourceRefDensity,
      compileSelectCount: community.selection.cumulativeCompileSelectCount,
      health: {
        dead: community.classification.primary === "dead_zone_reachability_risk",
        stale:
          community.classification.primary === "dead_zone_stale" ||
          community.quality.avgStalenessFactor >= 0.75,
        thinEvidence:
          community.classification.primary === "feedback_insufficient" ||
          community.feedback.feedbackConfidence === "insufficient" ||
          community.quality.sourceRefDensity < 0.2,
      },
    };
    bundle.landscape = {
      classification: community.classification.primary,
      confidence: community.classification.confidence,
      attractorScore: num(community.scores.attractorScore),
      negativeScore: num(community.scores.negativeScore),
      reachabilityRiskScore: num(community.scores.reachabilityRiskScore),
      usedRate: num(community.feedback.usedRate),
      notUsedRate: num(community.feedback.notUsedRate),
      offTopicRate: num(community.feedback.offTopicRate),
      wrongRate: num(community.feedback.wrongRate),
      flags: community.classification.flags,
    };
  }
}

async function loadPostgresLatestLandscapeSnapshot(): Promise<LandscapeSnapshot | null> {
  const result = await db.execute(sql`
    select payload
    from landscape_snapshots
    where snapshot_type = 'landscape_snapshot'
      and status = 'ready'
    order by generated_at desc, updated_at desc
    limit 1
  `);
  const row = result.rows[0] as { payload?: unknown } | undefined;
  return asLandscapeSnapshot(row?.payload);
}

async function loadPostgresSignals(knowledgeIds: string[]): Promise<DecisionSignalLoadResult> {
  const idsSql = sql.join(
    knowledgeIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const compileResult = await db.execute(sql`
    with ids as (
      select unnest(array[${idsSql}])::uuid as id
    ),
    trace_agg as (
      select
        item_id as knowledge_id,
        count(*) filter (where selected = true)::int as recent_selected_count,
        count(*) filter (where suppressed = true)::int as suppressed_count,
        count(*) filter (where agentic_decision = 'rejected')::int as rejected_by_agentic_count,
        count(distinct e.id) filter (where e.outcome in ('misleading', 'unused'))::int as misleading_eval_count
      from context_compile_candidate_traces c
      left join context_compile_evals e on e.run_id = c.run_id
      where item_id in (select id from ids)
      group by item_id
    ),
    usage_agg as (
      select
        knowledge_id,
        count(*) filter (where verdict = 'used')::int as used_count,
        count(*) filter (where verdict = 'not_used')::int as not_used_count,
        count(*) filter (where verdict = 'off_topic')::int as off_topic_count,
        count(*) filter (where verdict = 'wrong')::int as wrong_count
      from knowledge_usage_events
      where knowledge_id in (select id from ids)
      group by knowledge_id
    )
    select
      ids.id::text as knowledge_id,
      coalesce(k.compile_select_count, 0)::int as compile_select_count,
      coalesce(t.recent_selected_count, 0)::int as recent_selected_count,
      coalesce(u.used_count, 0)::int as used_count,
      coalesce(u.not_used_count, 0)::int as not_used_count,
      coalesce(u.off_topic_count, 0)::int as off_topic_count,
      coalesce(u.wrong_count, 0)::int as wrong_count,
      coalesce(t.suppressed_count, 0)::int as suppressed_count,
      coalesce(t.rejected_by_agentic_count, 0)::int as rejected_by_agentic_count,
      coalesce(t.misleading_eval_count, 0)::int as misleading_eval_count
    from ids
    left join knowledge_items k on k.id = ids.id
    left join trace_agg t on t.knowledge_id = ids.id
    left join usage_agg u on u.knowledge_id = ids.id
  `);

  const communityResult = await db.execute(sql`
    with latest_trace as (
      select distinct on (item_id)
        item_id::text as knowledge_id,
        community_key
      from context_compile_candidate_traces
      where item_id in (select unnest(array[${idsSql}])::uuid)
        and community_key is not null
      order by item_id, created_at desc
    ),
    community_agg as (
      select
        community_key,
        count(*) filter (where selected = true)::int as compile_select_count
      from context_compile_candidate_traces
      where community_key in (select community_key from latest_trace)
      group by community_key
    )
    select
      latest_trace.knowledge_id,
      latest_trace.community_key,
      labels.label as community_label,
      coalesce(community_agg.compile_select_count, 0)::int as compile_select_count
    from latest_trace
    left join knowledge_community_labels labels
      on labels.community_key = latest_trace.community_key
    left join community_agg
      on community_agg.community_key = latest_trace.community_key
  `);

  const bundles = new Map<string, DecisionSignalBundle>(
    knowledgeIds.map((id) => [id, emptyDecisionSignalBundle()]),
  );
  for (const row of compileResult.rows as CompileSignalRow[]) {
    const id = row.knowledge_id;
    if (!id) continue;
    const bundle = bundles.get(id) ?? emptyDecisionSignalBundle();
    bundle.compile = {
      compileSelectCount: num(row.compile_select_count),
      recentSelectedCount: num(row.recent_selected_count),
      usedCount: num(row.used_count),
      notUsedCount: num(row.not_used_count),
      offTopicCount: num(row.off_topic_count),
      wrongCount: num(row.wrong_count),
      suppressedCount: num(row.suppressed_count),
      rejectedByAgenticCount: num(row.rejected_by_agentic_count),
      misleadingEvalCount: num(row.misleading_eval_count),
    };
    bundles.set(id, bundle);
  }
  for (const row of communityResult.rows as CommunitySignalRow[]) {
    const id = row.knowledge_id;
    if (!id) continue;
    const bundle = bundles.get(id) ?? emptyDecisionSignalBundle();
    bundle.community = {
      communityKey: row.community_key ?? null,
      communityLabel: row.community_label ?? row.community_key ?? null,
      communityRank: null,
      sourceRefDensity: null,
      compileSelectCount: num(row.compile_select_count),
      health: { dead: false, stale: false, thinEvidence: false },
    };
    bundles.set(id, bundle);
  }
  applyLandscapeSignals(bundles, await loadPostgresLatestLandscapeSnapshot());
  return { status: "complete", bundles, reason: "signals loaded" };
}

async function getSqliteCoreDatabase() {
  const { getRuntimeSqliteCoreDatabase } = await import("../../db/sqlite/runtime.js");
  return getRuntimeSqliteCoreDatabase();
}

async function loadSqliteLatestLandscapeSnapshot(): Promise<LandscapeSnapshot | null> {
  const sqlite = await getSqliteCoreDatabase();
  const row = sqlite.db
    .query<{ payload: string }, []>(
      `
      select payload
      from landscape_snapshots
      where snapshot_type = 'landscape_snapshot'
        and status = 'ready'
      order by datetime(generated_at) desc, datetime(updated_at) desc
      limit 1
    `,
    )
    .get();
  return asLandscapeSnapshot(row?.payload);
}

async function loadSqliteSignals(knowledgeIds: string[]): Promise<DecisionSignalLoadResult> {
  const sqlite = await getSqliteCoreDatabase();
  const placeholders = knowledgeIds.map(() => "?").join(", ");
  const compileRows = sqlite.db
    .query<CompileSignalRow, string[]>(
      `
      select
        k.id as knowledge_id,
        coalesce(k.compile_select_count, 0) as compile_select_count,
        coalesce(t.recent_selected_count, 0) as recent_selected_count,
        coalesce(u.used_count, 0) as used_count,
        coalesce(u.not_used_count, 0) as not_used_count,
        coalesce(u.off_topic_count, 0) as off_topic_count,
        coalesce(u.wrong_count, 0) as wrong_count,
        coalesce(t.suppressed_count, 0) as suppressed_count,
        coalesce(t.rejected_by_agentic_count, 0) as rejected_by_agentic_count,
        coalesce(t.misleading_eval_count, 0) as misleading_eval_count
      from knowledge_items k
      left join (
        select
          c.item_id as knowledge_id,
          sum(case when c.selected = 1 then 1 else 0 end) as recent_selected_count,
          sum(case when c.suppressed = 1 then 1 else 0 end) as suppressed_count,
          sum(case when c.agentic_decision = 'rejected' then 1 else 0 end) as rejected_by_agentic_count,
          count(distinct case when e.outcome in ('misleading', 'unused') then e.id else null end) as misleading_eval_count
        from context_compile_candidate_traces c
        left join context_compile_evals e on e.run_id = c.run_id
        where c.item_id in (${placeholders})
        group by c.item_id
      ) t on t.knowledge_id = k.id
      left join (
        select
          knowledge_id,
          sum(case when verdict = 'used' then 1 else 0 end) as used_count,
          sum(case when verdict = 'not_used' then 1 else 0 end) as not_used_count,
          sum(case when verdict = 'off_topic' then 1 else 0 end) as off_topic_count,
          sum(case when verdict = 'wrong' then 1 else 0 end) as wrong_count
        from knowledge_usage_events
        where knowledge_id in (${placeholders})
        group by knowledge_id
      ) u on u.knowledge_id = k.id
      where k.id in (${placeholders})
    `,
    )
    .all(...knowledgeIds, ...knowledgeIds, ...knowledgeIds);

  const communityRows = sqlite.db
    .query<CommunitySignalRow, string[]>(
      `
      select
        latest.knowledge_id,
        latest.community_key,
        labels.label as community_label,
        coalesce(agg.compile_select_count, 0) as compile_select_count
      from (
        select
          c.item_id as knowledge_id,
          c.community_key
        from context_compile_candidate_traces c
        join (
          select item_id, max(created_at) as max_created_at
          from context_compile_candidate_traces
          where item_id in (${placeholders})
            and community_key is not null
          group by item_id
        ) latest_key
          on latest_key.item_id = c.item_id
         and latest_key.max_created_at = c.created_at
        where c.community_key is not null
      ) latest
      left join knowledge_community_labels labels on labels.community_key = latest.community_key
      left join (
        select community_key, sum(case when selected = 1 then 1 else 0 end) as compile_select_count
        from context_compile_candidate_traces
        where community_key is not null
        group by community_key
      ) agg on agg.community_key = latest.community_key
    `,
    )
    .all(...knowledgeIds);

  const bundles = new Map<string, DecisionSignalBundle>(
    knowledgeIds.map((id) => [id, emptyDecisionSignalBundle()]),
  );
  for (const row of compileRows) {
    const id = row.knowledge_id;
    if (!id) continue;
    const bundle = bundles.get(id) ?? emptyDecisionSignalBundle();
    bundle.compile = {
      compileSelectCount: num(row.compile_select_count),
      recentSelectedCount: num(row.recent_selected_count),
      usedCount: num(row.used_count),
      notUsedCount: num(row.not_used_count),
      offTopicCount: num(row.off_topic_count),
      wrongCount: num(row.wrong_count),
      suppressedCount: num(row.suppressed_count),
      rejectedByAgenticCount: num(row.rejected_by_agentic_count),
      misleadingEvalCount: num(row.misleading_eval_count),
    };
    bundles.set(id, bundle);
  }
  for (const row of communityRows) {
    const id = row.knowledge_id;
    if (!id) continue;
    const bundle = bundles.get(id) ?? emptyDecisionSignalBundle();
    bundle.community = {
      communityKey: row.community_key ?? null,
      communityLabel: row.community_label ?? row.community_key ?? null,
      communityRank: null,
      sourceRefDensity: null,
      compileSelectCount: num(row.compile_select_count),
      health: { dead: false, stale: false, thinEvidence: false },
    };
    bundles.set(id, bundle);
  }
  applyLandscapeSignals(bundles, await loadSqliteLatestLandscapeSnapshot());
  return { status: "complete", bundles, reason: "signals loaded" };
}

export async function loadDecisionSignalBundles(
  knowledgeIds: string[],
): Promise<DecisionSignalLoadResult> {
  const ids = uniqueIds(knowledgeIds);
  if (ids.length === 0) {
    return { status: "complete", bundles: new Map(), reason: "no evidence ids" };
  }
  try {
    if (resolveDatabaseBackendConfig().kind === "sqlite") {
      return await loadSqliteSignals(ids);
    }
    return await loadPostgresSignals(ids);
  } catch (error) {
    return {
      status: "failed",
      bundles: new Map(ids.map((id) => [id, emptyDecisionSignalBundle()])),
      reason: error instanceof Error ? error.message : "signal load failed",
    };
  }
}
