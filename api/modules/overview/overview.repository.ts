import { sql } from "drizzle-orm";
import { groupedConfig } from "../../../src/config.js";
import { resolveDatabaseBackendConfig } from "../../../src/db/backend.js";
import { getDb } from "../../../src/db/index.js";
import { inspectCompileRuns } from "../../../src/modules/doctor/inspectors/compile.inspector.js";
import { buildLandscapeReplayComparison } from "../../../src/modules/landscape/landscape-replay-comparison.service.js";
import { resolveCostRate } from "../../../src/modules/llm/llm-cost-config.js";
import { ensureRuntimeSettingsLoaded } from "../../../src/modules/settings/settings.service.js";
import {
  type OverviewDashboard,
  type OverviewDomainName,
  type OverviewKnowledgeAssetsDomain,
  type OverviewLandscapeHealthDomain,
  type OverviewLlmResourcesDomain,
  type OverviewSystemQualityDomain,
  overviewCompileEvalStatsSchema,
  overviewDashboardSchema,
  overviewKnowledgeAssetsDomainSchema,
  overviewLandscapeHealthDomainSchema,
  overviewLlmResourcesDomainSchema,
  overviewProductValueStatsSchema,
  overviewSystemQualityDomainSchema,
} from "../../../src/shared/schemas/overview.schema.js";
import { type GraphCommunitySummary, buildGraphSnapshot } from "../graph/graph.repository.js";
import {
  DASHBOARD_TIMEZONE,
  LANDSCAPE_OVERVIEW_CURRENT_LIMIT,
  LANDSCAPE_OVERVIEW_REPLAY_LIMIT,
  LANDSCAPE_OVERVIEW_WINDOW_DAYS,
  LLM_KPI_DAY_RANGE,
  OVERVIEW_DAY_RANGE,
  buildCommunitySourceCoverage,
  buildKnowledgeStatusTypeChart,
  buildOverviewLandscapeSummary,
  checkedAt,
  countWikiPages,
  latestCheckedAt,
  normalizeOverviewTimezone,
  normalizeSearchApiStatus,
  sqliteTimezoneModifier,
  stringValue,
  toNullableNumber,
  toNumber,
} from "./overview.repository.helpers.js";

type OverviewDomainPayload =
  | OverviewKnowledgeAssetsDomain
  | OverviewLandscapeHealthDomain
  | OverviewSystemQualityDomain
  | OverviewLlmResourcesDomain;

export { normalizeSearchApiStatus } from "./overview.repository.helpers.js";

async function getSqliteCoreDatabase() {
  const { getRuntimeSqliteCoreDatabase } = await import("../../../src/db/sqlite/runtime.js");
  return getRuntimeSqliteCoreDatabase();
}

function isSqliteBackend(): boolean {
  return resolveDatabaseBackendConfig().kind === "sqlite";
}

function timezoneDateString(value: string | Date, timezone: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return year && month && day ? `${year}-${month}-${day}` : "";
}

function shiftIsoDate(day: string, offsetDays: number): string {
  const [year, month, date] = day.split("-").map(Number);
  if (!year || !month || !date) return day;
  return new Date(Date.UTC(year, month - 1, date + offsetDays)).toISOString().slice(0, 10);
}

function emptyDaySeries(timezone: string, days = OVERVIEW_DAY_RANGE) {
  const today = timezoneDateString(new Date(), timezone);
  return Array.from({ length: days }, (_, index) => shiftIsoDate(today, index - (days - 1)));
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function sqliteGet<T extends Record<string, unknown>>(
  sqlite: Awaited<ReturnType<typeof getSqliteCoreDatabase>>,
  query: string,
  ...params: unknown[]
): T {
  return sqlite.db.query<T, unknown[]>(query).get(...params) ?? ({} as T);
}

function sqliteAll<T extends Record<string, unknown>>(
  sqlite: Awaited<ReturnType<typeof getSqliteCoreDatabase>>,
  query: string,
  ...params: unknown[]
): T[] {
  return sqlite.db.query<T, unknown[]>(query).all(...params);
}

function dailyRows<T extends Record<string, unknown>>(
  rows: T[],
  defaults: (day: string) => T,
  timezone: string,
  days = OVERVIEW_DAY_RANGE,
): T[] {
  const byDay = new Map(rows.map((row) => [String(row.day ?? ""), row]));
  return emptyDaySeries(timezone, days).map((day) => byDay.get(day) ?? defaults(day));
}

function buildCompileEvalStats(row: Record<string, unknown>) {
  return overviewCompileEvalStatsSchema.parse({
    windowLabel: "All time",
    evaluatedRunCount: toNumber(row.evaluated_run_count),
    evaluationCount: toNumber(row.evaluation_count),
    averageAvg: toNullableNumber(row.average_avg),
    metrics: [
      { metric: "relevance", label: "Relevance", average: toNullableNumber(row.relevance_avg) },
      {
        metric: "actionability",
        label: "Actionability",
        average: toNullableNumber(row.actionability_avg),
      },
      { metric: "coverage", label: "Coverage", average: toNullableNumber(row.coverage_avg) },
      { metric: "clarity", label: "Clarity", average: toNullableNumber(row.clarity_avg) },
      {
        metric: "specificity",
        label: "Specificity",
        average: toNullableNumber(row.specificity_avg),
      },
    ],
  });
}

function rate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Number((numerator / denominator).toFixed(3));
}

function buildProductValueStats(row: Record<string, unknown>) {
  const compileRunCount = toNumber(row.compile_run_count);
  const evaluatedCompileRunCount = toNumber(row.evaluated_compile_run_count);
  const compileEvaluationCount = toNumber(row.compile_evaluation_count);
  const acceptedCompileEvaluationCount = toNumber(row.accepted_compile_evaluation_count);
  const reusedCompileRunCount = toNumber(row.reused_compile_run_count);
  const decisionRunCount = toNumber(row.decision_run_count);
  const decisionFeedbackCount = toNumber(row.decision_feedback_count);
  const knownDecisionFeedbackCount = toNumber(row.known_decision_feedback_count);
  const successfulDecisionFeedbackCount = toNumber(row.successful_decision_feedback_count);
  const badDecisionFeedbackCount = toNumber(row.bad_decision_feedback_count);
  const preventedReworkSignalCount = toNumber(row.prevented_rework_signal_count);
  const appliedFeedbackEffectCount = toNumber(row.applied_feedback_effect_count);

  return overviewProductValueStatsSchema.parse({
    windowLabel: "All time",
    metrics: [
      {
        metric: "compile_adoption_rate",
        label: "Compile adoption",
        rate: rate(acceptedCompileEvaluationCount, compileEvaluationCount),
        count: acceptedCompileEvaluationCount,
        denominator: compileEvaluationCount,
        evidenceLabel: "useful/partial compile_eval outcomes",
      },
      {
        metric: "compile_reuse_rate",
        label: "Compile reuse",
        rate: rate(reusedCompileRunCount, compileRunCount),
        count: reusedCompileRunCount,
        denominator: compileRunCount,
        evidenceLabel: "compile runs with pack items or selected traces",
      },
      {
        metric: "decision_success_rate",
        label: "Decision success",
        rate: rate(successfulDecisionFeedbackCount, knownDecisionFeedbackCount),
        count: successfulDecisionFeedbackCount,
        denominator: knownDecisionFeedbackCount,
        evidenceLabel: "human good plus system success feedback",
      },
      {
        metric: "bad_feedback_rate",
        label: "Bad feedback",
        rate: rate(badDecisionFeedbackCount, knownDecisionFeedbackCount),
        count: badDecisionFeedbackCount,
        denominator: knownDecisionFeedbackCount,
        evidenceLabel: "human bad plus failed/regression/override/discard feedback",
      },
      {
        metric: "prevented_rework_signals",
        label: "Rework avoided",
        rate: null,
        count: preventedReworkSignalCount,
        denominator: decisionRunCount,
        evidenceLabel: "revise/rollback/discard/reject decisions plus applied feedback effects",
      },
    ],
    evidence: {
      compileRunCount,
      evaluatedCompileRunCount,
      compileEvaluationCount,
      acceptedCompileEvaluationCount,
      reusedCompileRunCount,
      decisionRunCount,
      decisionFeedbackCount,
      knownDecisionFeedbackCount,
      successfulDecisionFeedbackCount,
      badDecisionFeedbackCount,
      preventedReworkSignalCount,
      appliedFeedbackEffectCount,
    },
  });
}

async function fetchOverviewKnowledgeAssetsDomainForSqlite(
  timezone = DASHBOARD_TIMEZONE,
): Promise<OverviewKnowledgeAssetsDomain> {
  await ensureRuntimeSettingsLoaded();
  const sqlite = await getSqliteCoreDatabase();
  const timezoneModifier = sqliteTimezoneModifier(timezone);

  const knowledgeSummaryRow = sqliteGet<Record<string, unknown>>(
    sqlite,
    `
      with source_linked as (
        select distinct knowledge_id from knowledge_source_links
      ),
      origin_linked as (
        select distinct knowledge_id from knowledge_origin_links
      ),
      provenance_traceable as (
        select knowledge_id from source_linked
        union
        select knowledge_id from origin_linked
      )
      select
        count(*) as knowledge_total,
        sum(case when status = 'active' then 1 else 0 end) as active_knowledge,
        sum(case when status = 'draft' then 1 else 0 end) as draft_knowledge,
        sum(case when status = 'deprecated' then 1 else 0 end) as deprecated_knowledge,
        sum(case when type = 'rule' then 1 else 0 end) as rules,
        sum(case when type = 'procedure' then 1 else 0 end) as procedures,
        (select count(*) from knowledge_items_vec_fallback) as embedded_knowledge,
        sum(case when status = 'active' and compile_select_count = 0 then 1 else 0 end)
          as zero_use_active_knowledge,
        coalesce((select count(*) from source_linked), 0) as source_evidence_linked_knowledge,
        coalesce((select count(*) from origin_linked), 0) as origin_linked_knowledge,
        coalesce((select count(*) from provenance_traceable), 0)
          as provenance_traceable_knowledge
      from knowledge_items
    `,
  );
  const sourceSummaryRow = sqliteGet<Record<string, unknown>>(
    sqlite,
    `
      select
        (select count(*) from sources) as indexed_sources,
        (select count(*) from source_fragments) as source_fragments,
        (select count(*) from knowledge_source_links) as source_links
    `,
  );
  const vibeSummaryRow = sqliteGet<Record<string, unknown>>(
    sqlite,
    `
      select
        count(distinct vm.id) as vibe_records,
        count(distinct vm.session_id) as vibe_sessions,
        count(distinct case when ade.id is not null then vm.id end) as vibe_records_with_diffs,
        count(ade.id) as agent_diff_entries
      from vibe_memories vm
      left join agent_diff_entries ade on ade.vibe_memory_id = vm.id
    `,
  );
  const knowledgeByStatusTypeRows = sqliteAll<Record<string, unknown>>(
    sqlite,
    `
      select status, type, count(*) as item_count
      from knowledge_items
      where status in ('active', 'draft', 'deprecated')
        and type in ('rule', 'procedure')
      group by status, type
    `,
  );
  const dynamicScoreBucketRow = sqliteGet<Record<string, unknown>>(
    sqlite,
    `
      select
        sum(case when dynamic_score = 0 then 1 else 0 end) as bucket_0,
        sum(case when dynamic_score > 0 and dynamic_score <= 1 then 1 else 0 end) as bucket_0_1,
        sum(case when dynamic_score > 1 and dynamic_score <= 5 then 1 else 0 end) as bucket_1_5,
        sum(case when dynamic_score > 5 and dynamic_score <= 10 then 1 else 0 end) as bucket_5_10,
        sum(case when dynamic_score > 10 and dynamic_score <= 15 then 1 else 0 end) as bucket_10_15,
        sum(case when dynamic_score > 15 and dynamic_score <= 20 then 1 else 0 end) as bucket_15_20,
        sum(case when dynamic_score > 20 and dynamic_score <= 25 then 1 else 0 end) as bucket_20_25,
        sum(case when dynamic_score > 25 and dynamic_score <= 30 then 1 else 0 end) as bucket_25_30,
        sum(case when dynamic_score > 30 and dynamic_score <= 35 then 1 else 0 end) as bucket_30_35,
        sum(case when dynamic_score > 35 then 1 else 0 end) as bucket_35_plus
      from knowledge_items
      where status = 'active'
    `,
  );
  const vibeRecordsByDayRows = dailyRows(
    sqliteAll<Record<string, unknown>>(
      sqlite,
      `
        select date(created_at, ?) as day, count(*) as records
        from vibe_memories
        where date(created_at, ?) >= date('now', ?, ?)
        group by date(created_at, ?)
        order by day asc
      `,
      timezoneModifier,
      timezoneModifier,
      timezoneModifier,
      `-${OVERVIEW_DAY_RANGE - 1} days`,
      timezoneModifier,
    ),
    (day) => ({ day, records: 0 }),
    timezone,
  );
  const originKindRows = sqliteAll<{ origin_kind: string; count: number }>(
    sqlite,
    `
      select origin_kind, count(distinct knowledge_id) as count
      from knowledge_origin_links
      group by origin_kind
    `,
  );

  const knowledgeTotal = toNumber(knowledgeSummaryRow.knowledge_total);
  const sourceEvidenceLinkedKnowledge = toNumber(
    knowledgeSummaryRow.source_evidence_linked_knowledge,
  );
  const originLinkedKnowledge = toNumber(knowledgeSummaryRow.origin_linked_knowledge);
  const provenanceTraceableKnowledge = toNumber(knowledgeSummaryRow.provenance_traceable_knowledge);
  const originLinksByKind: Record<string, number> = {
    vibe_memory: 0,
    agent_candidate: 0,
    landscape_review_item: 0,
  };
  for (const row of originKindRows) originLinksByKind[row.origin_kind] = toNumber(row.count);

  const communityGraph = await buildGraphSnapshot({
    limit: Math.max(1, knowledgeTotal),
    status: "all",
    view: "community",
    relationAxes: ["session", "project", "source"],
  });
  const communitySourceCoverage = buildCommunitySourceCoverage(communityGraph.communities);

  return overviewKnowledgeAssetsDomainSchema.parse({
    checkedAt: checkedAt(),
    kpis: {
      knowledgeTotal,
      activeKnowledge: toNumber(knowledgeSummaryRow.active_knowledge),
      draftKnowledge: toNumber(knowledgeSummaryRow.draft_knowledge),
      deprecatedKnowledge: toNumber(knowledgeSummaryRow.deprecated_knowledge),
      rules: toNumber(knowledgeSummaryRow.rules),
      procedures: toNumber(knowledgeSummaryRow.procedures),
      embeddedKnowledge: toNumber(knowledgeSummaryRow.embedded_knowledge),
      zeroUseActiveKnowledge: toNumber(knowledgeSummaryRow.zero_use_active_knowledge),
      wikiPages: await countWikiPages(),
      indexedSources: toNumber(sourceSummaryRow.indexed_sources),
      sourceFragments: toNumber(sourceSummaryRow.source_fragments),
      sourceLinks: toNumber(sourceSummaryRow.source_links),
      linkedKnowledge: sourceEvidenceLinkedKnowledge,
      unlinkedKnowledge: Math.max(0, knowledgeTotal - sourceEvidenceLinkedKnowledge),
      sourceEvidenceLinkedKnowledge,
      sourceEvidenceUnlinkedKnowledge: Math.max(0, knowledgeTotal - sourceEvidenceLinkedKnowledge),
      originLinkedKnowledge,
      originUnlinkedKnowledge: Math.max(0, knowledgeTotal - originLinkedKnowledge),
      provenanceTraceableKnowledge,
      provenanceUntraceableKnowledge: Math.max(0, knowledgeTotal - provenanceTraceableKnowledge),
      originLinksByKind,
      ...communitySourceCoverage,
      vibeRecords: toNumber(vibeSummaryRow.vibe_records),
      vibeSessions: toNumber(vibeSummaryRow.vibe_sessions),
      vibeRecordsWithDiffs: toNumber(vibeSummaryRow.vibe_records_with_diffs),
      agentDiffEntries: toNumber(vibeSummaryRow.agent_diff_entries),
      graphNodes: communityGraph.stats.visibleKnowledgeCount,
      graphEdges: communityGraph.stats.relationEdgeCount,
      graphEmbedded: communityGraph.stats.embeddedKnowledgeCount,
      graphSessionEdges: communityGraph.stats.sessionEdgeCount,
      graphProjectEdges: communityGraph.stats.projectEdgeCount,
      graphSourceEdges: communityGraph.stats.sourceEdgeCount,
    },
    charts: {
      knowledgeByStatusType: buildKnowledgeStatusTypeChart(knowledgeByStatusTypeRows),
      dynamicScoreBuckets: [
        { bucket: "0", count: toNumber(dynamicScoreBucketRow.bucket_0) },
        { bucket: "0-1", count: toNumber(dynamicScoreBucketRow.bucket_0_1) },
        { bucket: "1-5", count: toNumber(dynamicScoreBucketRow.bucket_1_5) },
        { bucket: "5-10", count: toNumber(dynamicScoreBucketRow.bucket_5_10) },
        { bucket: "10-15", count: toNumber(dynamicScoreBucketRow.bucket_10_15) },
        { bucket: "15-20", count: toNumber(dynamicScoreBucketRow.bucket_15_20) },
        { bucket: "20-25", count: toNumber(dynamicScoreBucketRow.bucket_20_25) },
        { bucket: "25-30", count: toNumber(dynamicScoreBucketRow.bucket_25_30) },
        { bucket: "30-35", count: toNumber(dynamicScoreBucketRow.bucket_30_35) },
        { bucket: "35+", count: toNumber(dynamicScoreBucketRow.bucket_35_plus) },
      ],
      vibeRecordsByDay: vibeRecordsByDayRows.map((row) => ({
        day: String(row.day ?? ""),
        records: toNumber(row.records),
      })),
      sourceCoverage: [
        { label: "linked", count: sourceEvidenceLinkedKnowledge },
        { label: "unlinked", count: Math.max(0, knowledgeTotal - sourceEvidenceLinkedKnowledge) },
      ],
      communitySourceCoverage: [
        { label: "covered", count: communitySourceCoverage.sourceCoveredCommunities },
        { label: "thin", count: communitySourceCoverage.sourceThinCommunities },
        { label: "no-source", count: communitySourceCoverage.sourceMissingCommunities },
      ],
    },
  });
}

async function fetchOverviewSystemQualityDomainForSqlite(
  timezone = DASHBOARD_TIMEZONE,
): Promise<OverviewSystemQualityDomain> {
  await ensureRuntimeSettingsLoaded();
  const sqlite = await getSqliteCoreDatabase();
  const timezoneModifier = sqliteTimezoneModifier(timezone);
  const compileSummaryRow = sqliteGet<Record<string, unknown>>(
    sqlite,
    `
      select
        count(*) as compile_runs,
        sum(case when status = 'ok' then 1 else 0 end) as compile_ok_runs,
        sum(case when status = 'degraded' then 1 else 0 end) as compile_degraded_runs,
        sum(case when status = 'failed' then 1 else 0 end) as compile_failed_runs
      from context_compile_runs
    `,
  );
  const compileRunsByDayRows = dailyRows(
    sqliteAll<Record<string, unknown>>(
      sqlite,
      `
        select
          date(created_at, ?) as day,
          sum(case when status = 'ok' then 1 else 0 end) as ok,
          sum(case when status = 'degraded' then 1 else 0 end) as degraded,
          sum(case when status = 'failed' then 1 else 0 end) as failed,
          avg(duration_ms) as avg_duration_ms
        from context_compile_runs
        where date(created_at, ?) >= date('now', ?, ?)
        group by date(created_at, ?)
        order by day asc
      `,
      timezoneModifier,
      timezoneModifier,
      timezoneModifier,
      `-${OVERVIEW_DAY_RANGE - 1} days`,
      timezoneModifier,
    ),
    (day) => ({ day, ok: 0, degraded: 0, failed: 0, avg_duration_ms: null }),
    timezone,
  );
  const searchProviderStateRow = sqliteGet<{ metadata?: string }>(
    sqlite,
    "select metadata from sync_states where id = 'distillation_search_providers' limit 1",
  );
  const compileRunHealthResult = await inspectCompileRuns({
    windowSize: 20,
    freshnessThresholdMinutes: groupedConfig.doctor.freshnessThresholdMinutes,
    degradedRateThreshold: groupedConfig.doctor.degradedRateThreshold,
    compileRunsTableAvailable: true,
  });
  const compileEvalStatsRow = sqliteGet<Record<string, unknown>>(
    sqlite,
    `
      select
        count(distinct run_id) as evaluated_run_count,
        count(*) as evaluation_count,
        round(avg(score), 1) as average_avg,
        round(avg(relevance), 1) as relevance_avg,
        round(avg(actionability), 1) as actionability_avg,
        round(avg(coverage), 1) as coverage_avg,
        round(avg(clarity), 1) as clarity_avg,
        round(avg(specificity), 1) as specificity_avg
      from context_compile_evals
    `,
  );
  const productValueStatsRow = sqliteGet<Record<string, unknown>>(
    sqlite,
    `
      with compile_run_reuse as (
        select
          r.id,
          count(distinct case when cpi.item_id is not null then cpi.item_id end)
            as pack_item_count,
          count(distinct case when cct.selected = 1 then cct.item_id end)
            as selected_trace_count
        from context_compile_runs r
        left join context_pack_items cpi on cpi.run_id = r.id
        left join context_compile_candidate_traces cct on cct.run_id = r.id
        group by r.id
      )
      select
        (select count(*) from context_compile_runs) as compile_run_count,
        (select count(distinct run_id) from context_compile_evals) as evaluated_compile_run_count,
        (select count(*) from context_compile_evals) as compile_evaluation_count,
        (select count(*) from context_compile_evals where outcome in ('useful', 'partial'))
          as accepted_compile_evaluation_count,
        (select count(*) from compile_run_reuse where pack_item_count > 0 or selected_trace_count > 0)
          as reused_compile_run_count,
        (select count(*) from context_decision_runs) as decision_run_count,
        ((select count(*) from context_decision_human_feedback) +
          (select count(*) from context_decision_feedback)) as decision_feedback_count,
        ((select count(*) from context_decision_human_feedback) +
          (select count(*) from context_decision_feedback where outcome <> 'still_unknown'))
          as known_decision_feedback_count,
        ((select count(*) from context_decision_human_feedback where value = 'good') +
          (select count(*) from context_decision_feedback where outcome = 'success'))
          as successful_decision_feedback_count,
        ((select count(*) from context_decision_human_feedback where value = 'bad') +
          (select count(*) from context_decision_feedback
           where outcome in ('failed', 'discarded_pr', 'user_overrode', 'regression_found')))
          as bad_decision_feedback_count,
        ((select count(*) from context_decision_runs
          where status = 'completed'
            and decision in ('revise_and_execute', 'rollback', 'discard', 'reject')) +
          (select count(distinct decision_run_id) from context_decision_feedback_effects
           where status = 'applied')) as prevented_rework_signal_count,
        (select count(*) from context_decision_feedback_effects where status = 'applied')
          as applied_feedback_effect_count
    `,
  );

  return overviewSystemQualityDomainSchema.parse({
    checkedAt: checkedAt(),
    kpis: {
      compileRuns: toNumber(compileSummaryRow.compile_runs),
      compileOkRuns: toNumber(compileSummaryRow.compile_ok_runs),
      compileDegradedRuns: toNumber(compileSummaryRow.compile_degraded_runs),
      compileFailedRuns: toNumber(compileSummaryRow.compile_failed_runs),
    },
    compileRunHealth: compileRunHealthResult.runs,
    compileEvalStats: buildCompileEvalStats(compileEvalStatsRow),
    productValueStats: buildProductValueStats(productValueStatsRow),
    charts: {
      compileRunsByDay: compileRunsByDayRows.map((row) => ({
        day: String(row.day ?? ""),
        ok: toNumber(row.ok),
        degraded: toNumber(row.degraded),
        failed: toNumber(row.failed),
        avgDurationMs: toNullableNumber(row.avg_duration_ms),
      })),
    },
    searchApiStatus: normalizeSearchApiStatus(parseJsonValue(searchProviderStateRow.metadata)),
  });
}

async function fetchOverviewLlmResourcesDomainForSqlite(
  timezone = DASHBOARD_TIMEZONE,
): Promise<OverviewLlmResourcesDomain> {
  await ensureRuntimeSettingsLoaded();
  const sqlite = await getSqliteCoreDatabase();
  const timezoneModifier = sqliteTimezoneModifier(timezone);
  const windowModifier = `-${LLM_KPI_DAY_RANGE - 1} days`;
  const overviewWindowModifier = `-${OVERVIEW_DAY_RANGE - 1} days`;
  const llmUsageKpiRow = sqliteGet<Record<string, unknown>>(
    sqlite,
    `
      select
        count(*) as total_calls_30d,
        sum(case when usage_mode = 'measured' then 1 else 0 end) as measured_calls_30d,
        sum(case when usage_mode = 'estimated' then 1 else 0 end) as estimated_calls_30d,
        coalesce(sum(case when provider = 'local-llm' then prompt_tokens + completion_tokens else 0 end), 0)
          as local_tokens_total_30d,
        coalesce(sum(case when provider = 'local-llm' then prompt_tokens else 0 end), 0)
          as local_prompt_tokens_30d,
        coalesce(sum(case when provider = 'local-llm' then completion_tokens else 0 end), 0)
          as local_completion_tokens_30d,
        coalesce(sum(case when provider <> 'local-llm' then prompt_tokens + completion_tokens else 0 end), 0)
          as cloud_tokens_total_30d,
        coalesce(sum(case when provider <> 'local-llm' then prompt_tokens else 0 end), 0)
          as cloud_prompt_tokens_30d,
        coalesce(sum(case when provider <> 'local-llm' then completion_tokens else 0 end), 0)
          as cloud_completion_tokens_30d,
        coalesce(sum(case when usage_mode = 'measured' then prompt_tokens + completion_tokens else 0 end), 0)
          as measured_tokens_total_30d,
        coalesce(sum(case when usage_mode = 'estimated' then prompt_tokens + completion_tokens else 0 end), 0)
          as estimated_tokens_total_30d,
        coalesce(sum(reasoning_tokens), 0) as reasoning_tokens_total_30d,
        coalesce(sum(case when provider <> 'local-llm' then cost_jpy else 0 end), 0)
          as cloud_cost_jpy_total_30d
      from llm_usage_logs
      where date(created_at, ?) >= date('now', ?, ?)
    `,
    timezoneModifier,
    timezoneModifier,
    windowModifier,
  );
  const cloudModelRow = sqliteGet<{ model?: string }>(
    sqlite,
    `
      select model
      from llm_usage_logs
      where provider <> 'local-llm'
        and date(created_at, ?) >= date('now', ?, ?)
      group by model
      order by count(*) desc, model asc
      limit 1
    `,
    timezoneModifier,
    timezoneModifier,
    windowModifier,
  );
  const llmUsageByDayRows = dailyRows(
    sqliteAll<Record<string, unknown>>(
      sqlite,
      `
        select
          date(created_at, ?) as day,
          coalesce(sum(case when provider = 'local-llm' then prompt_tokens else 0 end), 0)
            as local_prompt_tokens,
          coalesce(sum(case when provider = 'local-llm' then completion_tokens else 0 end), 0)
            as local_completion_tokens,
          coalesce(sum(case when provider = 'local-llm' then reasoning_tokens else 0 end), 0)
            as local_reasoning_tokens,
          coalesce(sum(case when provider <> 'local-llm' then prompt_tokens else 0 end), 0)
            as cloud_prompt_tokens,
          coalesce(sum(case when provider <> 'local-llm' then completion_tokens else 0 end), 0)
            as cloud_completion_tokens,
          coalesce(sum(case when provider <> 'local-llm' then reasoning_tokens else 0 end), 0)
            as cloud_reasoning_tokens,
          coalesce(sum(prompt_tokens + completion_tokens), 0) as total_tokens,
          coalesce(sum(case when usage_mode = 'measured' then prompt_tokens + completion_tokens else 0 end), 0)
            as measured_tokens,
          coalesce(sum(case when usage_mode = 'estimated' then prompt_tokens + completion_tokens else 0 end), 0)
            as estimated_tokens,
          sum(case when usage_mode = 'measured' then 1 else 0 end) as measured_calls,
          sum(case when usage_mode = 'estimated' then 1 else 0 end) as estimated_calls,
          coalesce(sum(case when provider <> 'local-llm' then cost_jpy else 0 end), 0) as cost_jpy
        from llm_usage_logs
        where date(created_at, ?) >= date('now', ?, ?)
        group by date(created_at, ?)
        order by day asc
      `,
      timezoneModifier,
      timezoneModifier,
      timezoneModifier,
      overviewWindowModifier,
      timezoneModifier,
    ),
    (day) => ({
      day,
      local_prompt_tokens: 0,
      local_completion_tokens: 0,
      local_reasoning_tokens: 0,
      cloud_prompt_tokens: 0,
      cloud_completion_tokens: 0,
      cloud_reasoning_tokens: 0,
      total_tokens: 0,
      measured_tokens: 0,
      estimated_tokens: 0,
      measured_calls: 0,
      estimated_calls: 0,
      cost_jpy: 0,
    }),
    timezone,
  );
  const llmUsageBySourceRows = sqliteAll<Record<string, unknown>>(
    sqlite,
    `
      select
        source,
        count(*) as calls,
        sum(case when usage_mode = 'measured' then 1 else 0 end) as measured_calls,
        sum(case when usage_mode = 'estimated' then 1 else 0 end) as estimated_calls,
        coalesce(sum(prompt_tokens), 0) as prompt_tokens,
        coalesce(sum(completion_tokens), 0) as completion_tokens,
        coalesce(sum(prompt_tokens + completion_tokens), 0) as total_tokens
      from llm_usage_logs
      where date(created_at, ?) >= date('now', ?, ?)
      group by source
      order by calls desc, source asc
    `,
    timezoneModifier,
    timezoneModifier,
    windowModifier,
  );
  const llmUsageTotalCalls = toNumber(llmUsageKpiRow.total_calls_30d);
  const llmUsageMeasuredCalls = toNumber(llmUsageKpiRow.measured_calls_30d);
  const cloudModel =
    stringValue(cloudModelRow.model) ??
    stringValue(groupedConfig.azureOpenAi.model) ??
    "default-cloud";
  const cloudCostRate = resolveCostRate(cloudModel);

  return overviewLlmResourcesDomainSchema.parse({
    checkedAt: checkedAt(),
    llmUsage: {
      kpis: {
        totalCalls30d: llmUsageTotalCalls,
        measuredCalls30d: llmUsageMeasuredCalls,
        estimatedCalls30d: toNumber(llmUsageKpiRow.estimated_calls_30d),
        localTokensTotal30d: toNumber(llmUsageKpiRow.local_tokens_total_30d),
        localPromptTokens30d: toNumber(llmUsageKpiRow.local_prompt_tokens_30d),
        localCompletionTokens30d: toNumber(llmUsageKpiRow.local_completion_tokens_30d),
        cloudTokensTotal30d: toNumber(llmUsageKpiRow.cloud_tokens_total_30d),
        cloudPromptTokens30d: toNumber(llmUsageKpiRow.cloud_prompt_tokens_30d),
        cloudCompletionTokens30d: toNumber(llmUsageKpiRow.cloud_completion_tokens_30d),
        measuredTokensTotal30d: toNumber(llmUsageKpiRow.measured_tokens_total_30d),
        estimatedTokensTotal30d: toNumber(llmUsageKpiRow.estimated_tokens_total_30d),
        measuredCoveragePercent30d:
          llmUsageTotalCalls > 0
            ? Number(((llmUsageMeasuredCalls / llmUsageTotalCalls) * 100).toFixed(1))
            : 0,
        reasoningTokensTotal30d: toNumber(llmUsageKpiRow.reasoning_tokens_total_30d),
        cloudCostJpyTotal30d: toNumber(llmUsageKpiRow.cloud_cost_jpy_total_30d),
        cloudModel,
        cloudInputCostJpyPerMTokens: cloudCostRate.inputJpyPerM,
        cloudOutputCostJpyPerMTokens: cloudCostRate.outputJpyPerM,
      },
      daily: llmUsageByDayRows.map((row) => ({
        day: String(row.day ?? ""),
        localPromptTokens: toNumber(row.local_prompt_tokens),
        localCompletionTokens: toNumber(row.local_completion_tokens),
        localReasoningTokens: toNumber(row.local_reasoning_tokens),
        cloudPromptTokens: toNumber(row.cloud_prompt_tokens),
        cloudCompletionTokens: toNumber(row.cloud_completion_tokens),
        cloudReasoningTokens: toNumber(row.cloud_reasoning_tokens),
        totalTokens: toNumber(row.total_tokens),
        measuredTokens: toNumber(row.measured_tokens),
        estimatedTokens: toNumber(row.estimated_tokens),
        measuredCalls: toNumber(row.measured_calls),
        estimatedCalls: toNumber(row.estimated_calls),
        costJpy: toNumber(row.cost_jpy),
      })),
      bySource: llmUsageBySourceRows.map((row) => ({
        source: String(row.source ?? "unknown"),
        calls: toNumber(row.calls),
        measuredCalls: toNumber(row.measured_calls),
        estimatedCalls: toNumber(row.estimated_calls),
        promptTokens: toNumber(row.prompt_tokens),
        completionTokens: toNumber(row.completion_tokens),
        totalTokens: toNumber(row.total_tokens),
      })),
    },
  });
}

function landscapeSummaryFromSnapshots(
  snapshotPayload: unknown,
  replayPayload: unknown,
): OverviewLandscapeHealthDomain["landscape"] | null {
  const snapshot = snapshotPayload as {
    stats?: Record<string, unknown>;
    risks?: unknown[];
  };
  const replay = replayPayload as {
    generatedAt?: unknown;
    comparedRunCount?: unknown;
    averageOverlapRate?: unknown;
    retainedItemCount?: unknown;
    missingFromCurrentItemCount?: unknown;
    newlyRetrievedItemCount?: unknown;
    usedBaselineLostItemCount?: unknown;
    currentNoMatchRunCount?: unknown;
    scoreTuning?: Record<string, unknown>;
    promotionGateSummary?: Record<string, unknown>;
  };
  if (!snapshot?.stats || !replay) return null;
  return {
    status: "ok",
    windowDays: 30,
    generatedAt: stringValue(replay.generatedAt) ?? checkedAt(),
    snapshot: {
      totalCommunities: toNumber(snapshot.stats.totalCommunities),
      strongAttractorCount: toNumber(snapshot.stats.strongAttractorCount),
      usefulAttractorCount: toNumber(snapshot.stats.usefulAttractorCount),
      negativeCandidateCount: toNumber(snapshot.stats.negativeCandidateCount),
      overSelectedNotUsedCount: toNumber(snapshot.stats.overSelectedNotUsedCount),
      deadZoneReachabilityCount: toNumber(snapshot.stats.deadZoneReachabilityCount),
      deadZoneStaleCount: toNumber(snapshot.stats.deadZoneStaleCount),
      feedbackInsufficientCount: toNumber(snapshot.stats.insufficientFeedbackCommunities),
      topRiskCount: Array.isArray(snapshot.risks) ? snapshot.risks.length : 0,
    },
    replay: {
      comparedRunCount: toNumber(replay.comparedRunCount),
      averageOverlapRate: toNumber(replay.averageOverlapRate),
      retainedItemCount: toNumber(replay.retainedItemCount),
      missingFromCurrentItemCount: toNumber(replay.missingFromCurrentItemCount),
      newlyRetrievedItemCount: toNumber(replay.newlyRetrievedItemCount),
      usedBaselineLostItemCount: toNumber(replay.usedBaselineLostItemCount),
      highChurnRunCount: toNumber(replay.scoreTuning?.highChurnRunCount),
      currentNoMatchRunCount: toNumber(replay.currentNoMatchRunCount),
      promotionGateMode:
        replay.promotionGateSummary?.gateMode === "review_required" ? "review_required" : "normal",
    },
  };
}

async function buildReplaySummaryFromCurrentRetrieval(): Promise<
  Extract<OverviewLandscapeHealthDomain["landscape"], { status: "ok" }>["replay"]
> {
  const replay = await buildLandscapeReplayComparison({
    windowDays: LANDSCAPE_OVERVIEW_WINDOW_DAYS,
    limit: LANDSCAPE_OVERVIEW_REPLAY_LIMIT,
    runStatus: "all",
    currentLimit: LANDSCAPE_OVERVIEW_CURRENT_LIMIT,
    includeRuns: false,
  });

  return {
    comparedRunCount: replay.comparedRunCount,
    averageOverlapRate: replay.averageOverlapRate,
    retainedItemCount: replay.retainedItemCount,
    missingFromCurrentItemCount: replay.missingFromCurrentItemCount,
    newlyRetrievedItemCount: replay.newlyRetrievedItemCount,
    usedBaselineLostItemCount: replay.usedBaselineLostItemCount,
    highChurnRunCount: replay.scoreTuning.highChurnRunCount,
    currentNoMatchRunCount: replay.currentNoMatchRunCount,
    promotionGateMode: replay.promotionGateSummary.gateMode,
  };
}

async function buildLandscapeSummaryFromGraphHealth(): Promise<
  OverviewLandscapeHealthDomain["landscape"] | null
> {
  const graph = await buildGraphSnapshot({
    limit: 1000,
    status: "active",
    view: "community",
    relationAxes: ["session", "project", "source"],
    communityDisplay: "detail",
  });
  const communities: GraphCommunitySummary[] = graph.communities;
  if (communities.length === 0) return null;

  const strongAttractorCount = communities.filter(
    (community) =>
      community.compileSelectCount >= 3 &&
      !community.health.dead &&
      !community.health.stale &&
      !community.health.thinEvidence,
  ).length;
  const usefulAttractorCount = communities.filter(
    (community) =>
      community.compileSelectCount > 0 &&
      community.compileSelectCount < 3 &&
      !community.health.dead &&
      !community.health.stale,
  ).length;
  const deadZoneReachabilityCount = communities.filter((community) => community.health.dead).length;
  const deadZoneStaleCount = communities.filter((community) => community.health.stale).length;
  const feedbackInsufficientCount = communities.filter(
    (community) => community.health.thinEvidence,
  ).length;
  const replay = await buildReplaySummaryFromCurrentRetrieval();

  return {
    status: "ok",
    windowDays: 30,
    generatedAt: checkedAt(),
    snapshot: {
      totalCommunities: communities.length,
      strongAttractorCount,
      usefulAttractorCount,
      negativeCandidateCount: 0,
      overSelectedNotUsedCount: 0,
      deadZoneReachabilityCount,
      deadZoneStaleCount,
      feedbackInsufficientCount,
      topRiskCount: deadZoneReachabilityCount + deadZoneStaleCount + feedbackInsufficientCount,
    },
    replay,
  };
}

async function fetchOverviewLandscapeHealthDomainForSqlite(
  _timezone = DASHBOARD_TIMEZONE,
): Promise<OverviewLandscapeHealthDomain> {
  await ensureRuntimeSettingsLoaded();
  const sqlite = await getSqliteCoreDatabase();
  const snapshotRow = sqliteGet<{ payload?: string }>(
    sqlite,
    `
      select payload
      from landscape_snapshots
      where snapshot_type = 'landscape_snapshot'
        and status = 'ready'
      order by generated_at desc, updated_at desc
      limit 1
    `,
  );
  const replayRow = sqliteGet<{ payload?: string }>(
    sqlite,
    `
      select payload
      from landscape_snapshots
      where snapshot_type = 'landscape_replay_comparison'
        and status = 'ready'
      order by generated_at desc, updated_at desc
      limit 1
    `,
  );
  const landscape = landscapeSummaryFromSnapshots(
    parseJsonValue(snapshotRow.payload),
    parseJsonValue(replayRow.payload),
  ) ??
    (await buildLandscapeSummaryFromGraphHealth()) ?? {
      status: "unavailable" as const,
      windowDays: 30,
      error:
        "SQLite landscape summary has no ready landscape snapshot cache or graph health data yet.",
    };

  return overviewLandscapeHealthDomainSchema.parse({
    checkedAt: checkedAt(),
    landscape,
  });
}

export async function fetchOverviewKnowledgeAssetsDomainForApi(
  timezone = DASHBOARD_TIMEZONE,
): Promise<OverviewKnowledgeAssetsDomain> {
  await ensureRuntimeSettingsLoaded();
  const db = getDb();

  const [
    knowledgeSummaryResult,
    sourceSummaryResult,
    vibeSummaryResult,
    knowledgeByStatusTypeResult,
    dynamicScoreBucketResult,
    vibeRecordsByDayResult,
    wikiPages,
    originKindSummaryResult,
  ] = await Promise.all([
    db.execute(sql`
      with source_linked as (
        select distinct knowledge_id from knowledge_source_links
      ),
      origin_linked as (
        select distinct knowledge_id from knowledge_origin_links
      ),
      provenance_traceable as (
        select knowledge_id from source_linked
        union
        select knowledge_id from origin_linked
      )
      select
        count(*)::int as knowledge_total,
        count(*) filter (where status = 'active')::int as active_knowledge,
        count(*) filter (where status = 'draft')::int as draft_knowledge,
        count(*) filter (where status = 'deprecated')::int as deprecated_knowledge,
        count(*) filter (where type = 'rule')::int as rules,
        count(*) filter (where type = 'procedure')::int as procedures,
        count(*) filter (where embedding is not null)::int as embedded_knowledge,
        count(*) filter (where status = 'active' and compile_select_count = 0)::int as zero_use_active_knowledge,
        coalesce((select count(*)::int from source_linked), 0)::int as source_evidence_linked_knowledge,
        coalesce((select count(*)::int from origin_linked), 0)::int as origin_linked_knowledge,
        coalesce((select count(*)::int from provenance_traceable), 0)::int as provenance_traceable_knowledge
      from knowledge_items
    `),
    db.execute(sql`
      select
        (select count(*)::int from sources) as indexed_sources,
        (select count(*)::int from source_fragments) as source_fragments,
        (select count(*)::int from knowledge_source_links) as source_links
    `),
    db.execute(sql`
      select
        count(distinct vm.id)::int as vibe_records,
        count(distinct vm.session_id)::int as vibe_sessions,
        count(distinct case when ade.id is not null then vm.id end)::int as vibe_records_with_diffs,
        count(ade.id)::int as agent_diff_entries
      from vibe_memories vm
      left join agent_diff_entries ade on ade.vibe_memory_id = vm.id
    `),
    db.execute(sql`
      select
        status,
        type,
        count(*)::int as item_count
      from knowledge_items
      where status in ('active', 'draft', 'deprecated')
        and type in ('rule', 'procedure')
      group by status, type
    `),
    db.execute(sql`
      select
        count(*) filter (where dynamic_score = 0)::int as bucket_0,
        count(*) filter (where dynamic_score > 0 and dynamic_score <= 1)::int as bucket_0_1,
        count(*) filter (where dynamic_score > 1 and dynamic_score <= 5)::int as bucket_1_5,
        count(*) filter (where dynamic_score > 5 and dynamic_score <= 10)::int as bucket_5_10,
        count(*) filter (where dynamic_score > 10 and dynamic_score <= 15)::int as bucket_10_15,
        count(*) filter (where dynamic_score > 15 and dynamic_score <= 20)::int as bucket_15_20,
        count(*) filter (where dynamic_score > 20 and dynamic_score <= 25)::int as bucket_20_25,
        count(*) filter (where dynamic_score > 25 and dynamic_score <= 30)::int as bucket_25_30,
        count(*) filter (where dynamic_score > 30 and dynamic_score <= 35)::int as bucket_30_35,
        count(*) filter (where dynamic_score > 35)::int as bucket_35_plus
      from knowledge_items
      where status = 'active'
    `),
    db.execute(sql`
      with days as (
        select generate_series(
          (now() at time zone ${timezone})::date - (${OVERVIEW_DAY_RANGE - 1} * interval '1 day'),
          (now() at time zone ${timezone})::date,
          interval '1 day'
        )::date as day
      ),
      daily_records as (
        select
          (created_at at time zone ${timezone})::date as day,
          count(*)::int as records
        from vibe_memories
        where (created_at at time zone ${timezone})::date >=
          (now() at time zone ${timezone})::date - (${OVERVIEW_DAY_RANGE - 1} * interval '1 day')
        group by 1
      )
      select
        to_char(days.day, 'YYYY-MM-DD') as day,
        coalesce(daily_records.records, 0)::int as records
      from days
      left join daily_records on daily_records.day = days.day
      order by days.day asc
    `),
    countWikiPages(),
    db.execute(sql`
      select
        origin_kind,
        count(distinct knowledge_id)::int as count
      from knowledge_origin_links
      group by origin_kind
    `),
  ]);

  const knowledgeSummaryRow = (knowledgeSummaryResult.rows[0] ?? {}) as Record<string, unknown>;
  const sourceSummaryRow = (sourceSummaryResult.rows[0] ?? {}) as Record<string, unknown>;
  const vibeSummaryRow = (vibeSummaryResult.rows[0] ?? {}) as Record<string, unknown>;
  const dynamicScoreBucketRow = (dynamicScoreBucketResult.rows[0] ?? {}) as Record<string, unknown>;

  const knowledgeTotal = toNumber(knowledgeSummaryRow.knowledge_total);
  const sourceEvidenceLinkedKnowledge = toNumber(
    knowledgeSummaryRow.source_evidence_linked_knowledge,
  );
  const originLinkedKnowledge = toNumber(knowledgeSummaryRow.origin_linked_knowledge);
  const provenanceTraceableKnowledge = toNumber(knowledgeSummaryRow.provenance_traceable_knowledge);

  const originLinksByKind: Record<string, number> = {
    vibe_memory: 0,
    agent_candidate: 0,
    landscape_review_item: 0,
  };
  for (const row of originKindSummaryResult.rows as Array<{ origin_kind: string; count: number }>) {
    originLinksByKind[row.origin_kind] = toNumber(row.count);
  }

  const communityGraph = await buildGraphSnapshot({
    limit: Math.max(1, knowledgeTotal),
    status: "all",
    view: "community",
    relationAxes: ["session", "project", "source"],
  });
  const communitySourceCoverage = buildCommunitySourceCoverage(communityGraph.communities);

  const domain: OverviewKnowledgeAssetsDomain = {
    checkedAt: checkedAt(),
    kpis: {
      knowledgeTotal,
      activeKnowledge: toNumber(knowledgeSummaryRow.active_knowledge),
      draftKnowledge: toNumber(knowledgeSummaryRow.draft_knowledge),
      deprecatedKnowledge: toNumber(knowledgeSummaryRow.deprecated_knowledge),
      rules: toNumber(knowledgeSummaryRow.rules),
      procedures: toNumber(knowledgeSummaryRow.procedures),
      embeddedKnowledge: toNumber(knowledgeSummaryRow.embedded_knowledge),
      zeroUseActiveKnowledge: toNumber(knowledgeSummaryRow.zero_use_active_knowledge),
      wikiPages,
      indexedSources: toNumber(sourceSummaryRow.indexed_sources),
      sourceFragments: toNumber(sourceSummaryRow.source_fragments),
      sourceLinks: toNumber(sourceSummaryRow.source_links),
      linkedKnowledge: sourceEvidenceLinkedKnowledge,
      unlinkedKnowledge: Math.max(0, knowledgeTotal - sourceEvidenceLinkedKnowledge),
      sourceEvidenceLinkedKnowledge,
      sourceEvidenceUnlinkedKnowledge: Math.max(0, knowledgeTotal - sourceEvidenceLinkedKnowledge),
      originLinkedKnowledge,
      originUnlinkedKnowledge: Math.max(0, knowledgeTotal - originLinkedKnowledge),
      provenanceTraceableKnowledge,
      provenanceUntraceableKnowledge: Math.max(0, knowledgeTotal - provenanceTraceableKnowledge),
      originLinksByKind,
      ...communitySourceCoverage,
      vibeRecords: toNumber(vibeSummaryRow.vibe_records),
      vibeSessions: toNumber(vibeSummaryRow.vibe_sessions),
      vibeRecordsWithDiffs: toNumber(vibeSummaryRow.vibe_records_with_diffs),
      agentDiffEntries: toNumber(vibeSummaryRow.agent_diff_entries),
      graphNodes: communityGraph.stats.visibleKnowledgeCount,
      graphEdges: communityGraph.stats.relationEdgeCount,
      graphEmbedded: communityGraph.stats.embeddedKnowledgeCount,
      graphSessionEdges: communityGraph.stats.sessionEdgeCount,
      graphProjectEdges: communityGraph.stats.projectEdgeCount,
      graphSourceEdges: communityGraph.stats.sourceEdgeCount,
    },
    charts: {
      knowledgeByStatusType: buildKnowledgeStatusTypeChart(
        knowledgeByStatusTypeResult.rows as Array<Record<string, unknown>>,
      ),
      dynamicScoreBuckets: [
        { bucket: "0", count: toNumber(dynamicScoreBucketRow.bucket_0) },
        { bucket: "0-1", count: toNumber(dynamicScoreBucketRow.bucket_0_1) },
        { bucket: "1-5", count: toNumber(dynamicScoreBucketRow.bucket_1_5) },
        { bucket: "5-10", count: toNumber(dynamicScoreBucketRow.bucket_5_10) },
        { bucket: "10-15", count: toNumber(dynamicScoreBucketRow.bucket_10_15) },
        { bucket: "15-20", count: toNumber(dynamicScoreBucketRow.bucket_15_20) },
        { bucket: "20-25", count: toNumber(dynamicScoreBucketRow.bucket_20_25) },
        { bucket: "25-30", count: toNumber(dynamicScoreBucketRow.bucket_25_30) },
        { bucket: "30-35", count: toNumber(dynamicScoreBucketRow.bucket_30_35) },
        { bucket: "35+", count: toNumber(dynamicScoreBucketRow.bucket_35_plus) },
      ],
      vibeRecordsByDay: (vibeRecordsByDayResult.rows as Array<Record<string, unknown>>).map(
        (row) => ({
          day: String(row.day ?? ""),
          records: toNumber(row.records),
        }),
      ),
      sourceCoverage: [
        { label: "linked", count: sourceEvidenceLinkedKnowledge },
        { label: "unlinked", count: Math.max(0, knowledgeTotal - sourceEvidenceLinkedKnowledge) },
      ],
      communitySourceCoverage: [
        { label: "covered", count: communitySourceCoverage.sourceCoveredCommunities },
        { label: "thin", count: communitySourceCoverage.sourceThinCommunities },
        { label: "no-source", count: communitySourceCoverage.sourceMissingCommunities },
      ],
    },
  };

  return overviewKnowledgeAssetsDomainSchema.parse(domain);
}

export async function fetchOverviewSystemQualityDomainForApi(
  timezone = DASHBOARD_TIMEZONE,
): Promise<OverviewSystemQualityDomain> {
  await ensureRuntimeSettingsLoaded();
  const db = getDb();

  const [
    compileSummaryResult,
    compileRunsByDayResult,
    searchProviderStateResult,
    compileRunHealthResult,
    compileEvalStatsResult,
    productValueStatsResult,
  ] = await Promise.all([
    db.execute(sql`
      select
        count(*)::int as compile_runs,
        count(*) filter (where status = 'ok')::int as compile_ok_runs,
        count(*) filter (where status = 'degraded')::int as compile_degraded_runs,
        count(*) filter (where status = 'failed')::int as compile_failed_runs
      from context_compile_runs
    `),
    db.execute(sql`
      with days as (
        select generate_series(
          (now() at time zone ${timezone})::date - (${OVERVIEW_DAY_RANGE - 1} * interval '1 day'),
          (now() at time zone ${timezone})::date,
          interval '1 day'
        )::date as day
      ),
      daily_runs as (
        select
          (created_at at time zone ${timezone})::date as day,
          count(*) filter (where status = 'ok')::int as ok,
          count(*) filter (where status = 'degraded')::int as degraded,
          count(*) filter (where status = 'failed')::int as failed,
          avg(duration_ms)::float as avg_duration_ms
        from context_compile_runs
        where (created_at at time zone ${timezone})::date >=
          (now() at time zone ${timezone})::date - (${OVERVIEW_DAY_RANGE - 1} * interval '1 day')
        group by 1
      )
      select
        to_char(days.day, 'YYYY-MM-DD') as day,
        coalesce(daily_runs.ok, 0)::int as ok,
        coalesce(daily_runs.degraded, 0)::int as degraded,
        coalesce(daily_runs.failed, 0)::int as failed,
        daily_runs.avg_duration_ms
      from days
      left join daily_runs on daily_runs.day = days.day
      order by days.day asc
    `),
    db.execute(sql`
      select metadata
      from sync_states
      where id = 'distillation_search_providers'
      limit 1
    `),
    inspectCompileRuns({
      windowSize: 20,
      freshnessThresholdMinutes: groupedConfig.doctor.freshnessThresholdMinutes,
      degradedRateThreshold: groupedConfig.doctor.degradedRateThreshold,
      compileRunsTableAvailable: true,
    }),
    db.execute(sql`
      select
        count(distinct run_id)::int as evaluated_run_count,
        count(*)::int as evaluation_count,
        round(avg(score)::numeric, 1)::float as average_avg,
        round(avg(relevance)::numeric, 1)::float as relevance_avg,
        round(avg(actionability)::numeric, 1)::float as actionability_avg,
        round(avg(coverage)::numeric, 1)::float as coverage_avg,
        round(avg(clarity)::numeric, 1)::float as clarity_avg,
        round(avg(specificity)::numeric, 1)::float as specificity_avg
      from context_compile_evals
    `),
    db.execute(sql`
      with compile_run_reuse as (
        select
          r.id,
          (count(distinct cpi.item_id) filter (where cpi.item_id is not null))::int
            as pack_item_count,
          (count(distinct cct.item_id) filter (where cct.selected))::int as selected_trace_count
        from context_compile_runs r
        left join context_pack_items cpi on cpi.run_id = r.id
        left join context_compile_candidate_traces cct on cct.run_id = r.id
        group by r.id
      )
      select
        (select count(*)::int from context_compile_runs) as compile_run_count,
        (select count(distinct run_id)::int from context_compile_evals) as evaluated_compile_run_count,
        (select count(*)::int from context_compile_evals) as compile_evaluation_count,
        (select count(*)::int
         from context_compile_evals
         where outcome in ('useful', 'partial')) as accepted_compile_evaluation_count,
        (select count(*)::int
         from compile_run_reuse
         where pack_item_count > 0 or selected_trace_count > 0) as reused_compile_run_count,
        (select count(*)::int from context_decision_runs) as decision_run_count,
        ((select count(*)::int from context_decision_human_feedback) +
          (select count(*)::int from context_decision_feedback)) as decision_feedback_count,
        ((select count(*)::int from context_decision_human_feedback) +
          (select count(*)::int from context_decision_feedback where outcome <> 'still_unknown'))
          as known_decision_feedback_count,
        ((select count(*)::int from context_decision_human_feedback where value = 'good') +
          (select count(*)::int from context_decision_feedback where outcome = 'success'))
          as successful_decision_feedback_count,
        ((select count(*)::int from context_decision_human_feedback where value = 'bad') +
          (select count(*)::int
           from context_decision_feedback
           where outcome in ('failed', 'discarded_pr', 'user_overrode', 'regression_found')))
          as bad_decision_feedback_count,
        ((select count(*)::int
          from context_decision_runs
          where status = 'completed'
            and decision in ('revise_and_execute', 'rollback', 'discard', 'reject')) +
          (select count(distinct decision_run_id)::int
           from context_decision_feedback_effects
           where status = 'applied')) as prevented_rework_signal_count,
        (select count(*)::int from context_decision_feedback_effects where status = 'applied')
          as applied_feedback_effect_count
    `),
  ]);

  const compileSummaryRow = (compileSummaryResult.rows[0] ?? {}) as Record<string, unknown>;
  const searchProviderStateRow = (searchProviderStateResult.rows[0] ?? {}) as Record<
    string,
    unknown
  >;
  const compileEvalStatsRow = (compileEvalStatsResult.rows[0] ?? {}) as Record<string, unknown>;
  const productValueStatsRow = (productValueStatsResult.rows[0] ?? {}) as Record<string, unknown>;

  const domain: OverviewSystemQualityDomain = {
    checkedAt: checkedAt(),
    kpis: {
      compileRuns: toNumber(compileSummaryRow.compile_runs),
      compileOkRuns: toNumber(compileSummaryRow.compile_ok_runs),
      compileDegradedRuns: toNumber(compileSummaryRow.compile_degraded_runs),
      compileFailedRuns: toNumber(compileSummaryRow.compile_failed_runs),
    },
    compileRunHealth: compileRunHealthResult.runs,
    compileEvalStats: buildCompileEvalStats(compileEvalStatsRow),
    productValueStats: buildProductValueStats(productValueStatsRow),
    charts: {
      compileRunsByDay: (compileRunsByDayResult.rows as Array<Record<string, unknown>>).map(
        (row) => ({
          day: String(row.day ?? ""),
          ok: toNumber(row.ok),
          degraded: toNumber(row.degraded),
          failed: toNumber(row.failed),
          avgDurationMs: toNullableNumber(row.avg_duration_ms),
        }),
      ),
    },
    searchApiStatus: normalizeSearchApiStatus(searchProviderStateRow.metadata),
  };

  return overviewSystemQualityDomainSchema.parse(domain);
}

export async function fetchOverviewLlmResourcesDomainForApi(
  timezone = DASHBOARD_TIMEZONE,
): Promise<OverviewLlmResourcesDomain> {
  await ensureRuntimeSettingsLoaded();
  const db = getDb();

  const [llmUsageKpisResult, llmUsageByDayResult, llmUsageBySourceResult] = await Promise.all([
    db.execute(sql`
      with local_anchor as (
        select (now() at time zone ${timezone})::date as local_today
      ),
      window_usage as (
        select *
        from llm_usage_logs
        where (created_at at time zone ${timezone})::date >=
          ((select local_today from local_anchor) - (${LLM_KPI_DAY_RANGE - 1} * interval '1 day'))
      ),
      primary_cloud_model as (
        select model
        from window_usage
        where provider <> 'local-llm'
        group by model
        order by count(*) desc, model asc
        limit 1
      )
      select
        count(*)::int as total_calls_30d,
        count(*) filter (where usage_mode = 'measured')::int as measured_calls_30d,
        count(*) filter (where usage_mode = 'estimated')::int as estimated_calls_30d,
        coalesce(sum(prompt_tokens + completion_tokens) filter (where provider = 'local-llm'), 0)::int
          as local_tokens_total_30d,
        coalesce(sum(prompt_tokens) filter (where provider = 'local-llm'), 0)::int
          as local_prompt_tokens_30d,
        coalesce(sum(completion_tokens) filter (where provider = 'local-llm'), 0)::int
          as local_completion_tokens_30d,
        coalesce(sum(prompt_tokens + completion_tokens) filter (where provider <> 'local-llm'), 0)::int
          as cloud_tokens_total_30d,
        coalesce(sum(prompt_tokens) filter (where provider <> 'local-llm'), 0)::int
          as cloud_prompt_tokens_30d,
        coalesce(sum(completion_tokens) filter (where provider <> 'local-llm'), 0)::int
          as cloud_completion_tokens_30d,
        coalesce(sum(prompt_tokens + completion_tokens) filter (where usage_mode = 'measured'), 0)::int
          as measured_tokens_total_30d,
        coalesce(sum(prompt_tokens + completion_tokens) filter (where usage_mode = 'estimated'), 0)::int
          as estimated_tokens_total_30d,
        coalesce(sum(reasoning_tokens), 0)::int as reasoning_tokens_total_30d,
        coalesce(sum(cost_jpy) filter (where provider <> 'local-llm'), 0)::float
          as cloud_cost_jpy_total_30d,
        coalesce((select model from primary_cloud_model), ${groupedConfig.azureOpenAi.model})
          as cloud_model_30d
      from window_usage
    `),
    db.execute(sql`
      with local_anchor as (
        select (now() at time zone ${timezone})::date as local_today
      ),
      days as (
        select generate_series(
          (select local_today from local_anchor) - (${OVERVIEW_DAY_RANGE - 1} * interval '1 day'),
          (select local_today from local_anchor),
          interval '1 day'
        )::date as day
      ),
      daily_usage as (
        select
          (created_at at time zone ${timezone})::date as day,
          coalesce(sum(prompt_tokens) filter (where provider = 'local-llm'), 0)::int
            as local_prompt_tokens,
          coalesce(sum(completion_tokens) filter (where provider = 'local-llm'), 0)::int
            as local_completion_tokens,
          coalesce(sum(reasoning_tokens) filter (where provider = 'local-llm'), 0)::int
            as local_reasoning_tokens,
          coalesce(sum(prompt_tokens) filter (where provider <> 'local-llm'), 0)::int
            as cloud_prompt_tokens,
          coalesce(sum(completion_tokens) filter (where provider <> 'local-llm'), 0)::int
            as cloud_completion_tokens,
          coalesce(sum(reasoning_tokens) filter (where provider <> 'local-llm'), 0)::int
            as cloud_reasoning_tokens,
          coalesce(sum(prompt_tokens + completion_tokens), 0)::int as total_tokens,
          coalesce(sum(prompt_tokens + completion_tokens) filter (where usage_mode = 'measured'), 0)::int
            as measured_tokens,
          coalesce(sum(prompt_tokens + completion_tokens) filter (where usage_mode = 'estimated'), 0)::int
            as estimated_tokens,
          count(*) filter (where usage_mode = 'measured')::int as measured_calls,
          count(*) filter (where usage_mode = 'estimated')::int as estimated_calls,
          coalesce(sum(cost_jpy) filter (where provider <> 'local-llm'), 0)::float as cost_jpy
        from llm_usage_logs
        where (created_at at time zone ${timezone})::date >=
          ((select local_today from local_anchor) - (${OVERVIEW_DAY_RANGE - 1} * interval '1 day'))
        group by 1
      )
      select
        to_char(days.day, 'YYYY-MM-DD') as day,
        coalesce(daily_usage.local_prompt_tokens, 0)::int as local_prompt_tokens,
        coalesce(daily_usage.local_completion_tokens, 0)::int as local_completion_tokens,
        coalesce(daily_usage.local_reasoning_tokens, 0)::int as local_reasoning_tokens,
        coalesce(daily_usage.cloud_prompt_tokens, 0)::int as cloud_prompt_tokens,
        coalesce(daily_usage.cloud_completion_tokens, 0)::int as cloud_completion_tokens,
        coalesce(daily_usage.cloud_reasoning_tokens, 0)::int as cloud_reasoning_tokens,
        coalesce(daily_usage.total_tokens, 0)::int as total_tokens,
        coalesce(daily_usage.measured_tokens, 0)::int as measured_tokens,
        coalesce(daily_usage.estimated_tokens, 0)::int as estimated_tokens,
        coalesce(daily_usage.measured_calls, 0)::int as measured_calls,
        coalesce(daily_usage.estimated_calls, 0)::int as estimated_calls,
        coalesce(daily_usage.cost_jpy, 0)::float as cost_jpy
      from days
      left join daily_usage on daily_usage.day = days.day
      order by days.day asc
    `),
    db.execute(sql`
      with local_anchor as (
        select (now() at time zone ${timezone})::date as local_today
      )
      select
        source,
        count(*)::int as calls,
        count(*) filter (where usage_mode = 'measured')::int as measured_calls,
        count(*) filter (where usage_mode = 'estimated')::int as estimated_calls,
        coalesce(sum(prompt_tokens), 0)::int as prompt_tokens,
        coalesce(sum(completion_tokens), 0)::int as completion_tokens,
        coalesce(sum(prompt_tokens + completion_tokens), 0)::int as total_tokens
      from llm_usage_logs
      where (created_at at time zone ${timezone})::date >=
        ((select local_today from local_anchor) - (${LLM_KPI_DAY_RANGE - 1} * interval '1 day'))
      group by source
      order by calls desc, source asc
    `),
  ]);

  const llmUsageKpiRow = (llmUsageKpisResult.rows[0] ?? {}) as Record<string, unknown>;
  const llmUsageTotalCalls = toNumber(llmUsageKpiRow.total_calls_30d);
  const llmUsageMeasuredCalls = toNumber(llmUsageKpiRow.measured_calls_30d);
  const cloudModel =
    stringValue(llmUsageKpiRow.cloud_model_30d) ??
    stringValue(groupedConfig.azureOpenAi.model) ??
    "default-cloud";
  const cloudCostRate = resolveCostRate(cloudModel);

  const domain: OverviewLlmResourcesDomain = {
    checkedAt: checkedAt(),
    llmUsage: {
      kpis: {
        totalCalls30d: llmUsageTotalCalls,
        measuredCalls30d: llmUsageMeasuredCalls,
        estimatedCalls30d: toNumber(llmUsageKpiRow.estimated_calls_30d),
        localTokensTotal30d: toNumber(llmUsageKpiRow.local_tokens_total_30d),
        localPromptTokens30d: toNumber(llmUsageKpiRow.local_prompt_tokens_30d),
        localCompletionTokens30d: toNumber(llmUsageKpiRow.local_completion_tokens_30d),
        cloudTokensTotal30d: toNumber(llmUsageKpiRow.cloud_tokens_total_30d),
        cloudPromptTokens30d: toNumber(llmUsageKpiRow.cloud_prompt_tokens_30d),
        cloudCompletionTokens30d: toNumber(llmUsageKpiRow.cloud_completion_tokens_30d),
        measuredTokensTotal30d: toNumber(llmUsageKpiRow.measured_tokens_total_30d),
        estimatedTokensTotal30d: toNumber(llmUsageKpiRow.estimated_tokens_total_30d),
        measuredCoveragePercent30d:
          llmUsageTotalCalls > 0
            ? Number(((llmUsageMeasuredCalls / llmUsageTotalCalls) * 100).toFixed(1))
            : 0,
        reasoningTokensTotal30d: toNumber(llmUsageKpiRow.reasoning_tokens_total_30d),
        cloudCostJpyTotal30d: toNumber(llmUsageKpiRow.cloud_cost_jpy_total_30d),
        cloudModel,
        cloudInputCostJpyPerMTokens: cloudCostRate.inputJpyPerM,
        cloudOutputCostJpyPerMTokens: cloudCostRate.outputJpyPerM,
      },
      daily: (llmUsageByDayResult.rows as Array<Record<string, unknown>>).map((row) => ({
        day: String(row.day ?? ""),
        localPromptTokens: toNumber(row.local_prompt_tokens),
        localCompletionTokens: toNumber(row.local_completion_tokens),
        localReasoningTokens: toNumber(row.local_reasoning_tokens),
        cloudPromptTokens: toNumber(row.cloud_prompt_tokens),
        cloudCompletionTokens: toNumber(row.cloud_completion_tokens),
        cloudReasoningTokens: toNumber(row.cloud_reasoning_tokens),
        totalTokens: toNumber(row.total_tokens),
        measuredTokens: toNumber(row.measured_tokens),
        estimatedTokens: toNumber(row.estimated_tokens),
        measuredCalls: toNumber(row.measured_calls),
        estimatedCalls: toNumber(row.estimated_calls),
        costJpy: toNumber(row.cost_jpy),
      })),
      bySource: (llmUsageBySourceResult.rows as Array<Record<string, unknown>>).map((row) => ({
        source: String(row.source ?? "unknown"),
        calls: toNumber(row.calls),
        measuredCalls: toNumber(row.measured_calls),
        estimatedCalls: toNumber(row.estimated_calls),
        promptTokens: toNumber(row.prompt_tokens),
        completionTokens: toNumber(row.completion_tokens),
        totalTokens: toNumber(row.total_tokens),
      })),
    },
  };

  return overviewLlmResourcesDomainSchema.parse(domain);
}

export async function fetchOverviewLandscapeHealthDomainForApi(
  _timezone = DASHBOARD_TIMEZONE,
): Promise<OverviewLandscapeHealthDomain> {
  await ensureRuntimeSettingsLoaded();
  const domain: OverviewLandscapeHealthDomain = {
    checkedAt: checkedAt(),
    landscape: await buildOverviewLandscapeSummary(),
  };
  return overviewLandscapeHealthDomainSchema.parse(domain);
}

export async function fetchOverviewDomainForApi(
  domain: OverviewDomainName,
  timezone = DASHBOARD_TIMEZONE,
): Promise<OverviewDomainPayload> {
  const normalizedTimezone = normalizeOverviewTimezone(timezone);
  if (isSqliteBackend()) {
    if (domain === "knowledge-assets")
      return fetchOverviewKnowledgeAssetsDomainForSqlite(normalizedTimezone);
    if (domain === "landscape-health")
      return fetchOverviewLandscapeHealthDomainForSqlite(normalizedTimezone);
    if (domain === "system-quality")
      return fetchOverviewSystemQualityDomainForSqlite(normalizedTimezone);
    return fetchOverviewLlmResourcesDomainForSqlite(normalizedTimezone);
  }

  if (domain === "knowledge-assets")
    return fetchOverviewKnowledgeAssetsDomainForApi(normalizedTimezone);
  if (domain === "landscape-health")
    return fetchOverviewLandscapeHealthDomainForApi(normalizedTimezone);
  if (domain === "system-quality")
    return fetchOverviewSystemQualityDomainForApi(normalizedTimezone);
  return fetchOverviewLlmResourcesDomainForApi(normalizedTimezone);
}

export async function fetchOverviewDashboardForApi(
  timezone = DASHBOARD_TIMEZONE,
): Promise<OverviewDashboard> {
  const normalizedTimezone = normalizeOverviewTimezone(timezone);
  if (isSqliteBackend()) {
    const [knowledgeAssets, landscapeHealth, systemQuality, llmResources] = await Promise.all([
      fetchOverviewKnowledgeAssetsDomainForSqlite(normalizedTimezone),
      fetchOverviewLandscapeHealthDomainForSqlite(normalizedTimezone),
      fetchOverviewSystemQualityDomainForSqlite(normalizedTimezone),
      fetchOverviewLlmResourcesDomainForSqlite(normalizedTimezone),
    ]);

    return overviewDashboardSchema.parse({
      checkedAt: latestCheckedAt([
        knowledgeAssets.checkedAt,
        landscapeHealth.checkedAt,
        systemQuality.checkedAt,
        llmResources.checkedAt,
      ]),
      kpis: {
        ...knowledgeAssets.kpis,
        ...systemQuality.kpis,
      },
      charts: {
        ...knowledgeAssets.charts,
        ...systemQuality.charts,
      },
      llmUsage: llmResources.llmUsage,
      searchApiStatus: systemQuality.searchApiStatus,
      compileEvalStats: systemQuality.compileEvalStats,
      productValueStats: systemQuality.productValueStats,
      landscape: landscapeHealth.landscape,
    });
  }

  const [knowledgeAssets, landscapeHealth, systemQuality, llmResources] = await Promise.all([
    fetchOverviewKnowledgeAssetsDomainForApi(normalizedTimezone),
    fetchOverviewLandscapeHealthDomainForApi(normalizedTimezone),
    fetchOverviewSystemQualityDomainForApi(normalizedTimezone),
    fetchOverviewLlmResourcesDomainForApi(normalizedTimezone),
  ]);

  const dashboard: OverviewDashboard = {
    checkedAt: latestCheckedAt([
      knowledgeAssets.checkedAt,
      landscapeHealth.checkedAt,
      systemQuality.checkedAt,
      llmResources.checkedAt,
    ]),
    kpis: {
      ...knowledgeAssets.kpis,
      ...systemQuality.kpis,
    },
    charts: {
      ...knowledgeAssets.charts,
      ...systemQuality.charts,
    },
    llmUsage: llmResources.llmUsage,
    searchApiStatus: systemQuality.searchApiStatus,
    compileEvalStats: systemQuality.compileEvalStats,
    productValueStats: systemQuality.productValueStats,
    landscape: landscapeHealth.landscape,
  };

  return overviewDashboardSchema.parse(dashboard);
}
