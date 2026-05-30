import { sql } from "drizzle-orm";
import { groupedConfig } from "../../../src/config.js";
import { APP_CONSTANTS } from "../../../src/constants.js";
import { getDb } from "../../../src/db/index.js";
import { inspectCompileRuns } from "../../../src/modules/doctor/inspectors/compile.inspector.js";
import { resolveCostRate } from "../../../src/modules/llm/llm-cost-config.js";
import { ensureRuntimeSettingsLoaded } from "../../../src/modules/settings/settings.service.js";
import {
  type OverviewDashboard,
  type OverviewDomainName,
  type OverviewKnowledgeAssetsDomain,
  type OverviewLandscapeHealthDomain,
  type OverviewLlmResourcesDomain,
  type OverviewSystemQualityDomain,
  overviewDashboardSchema,
  overviewKnowledgeAssetsDomainSchema,
  overviewLandscapeHealthDomainSchema,
  overviewLlmResourcesDomainSchema,
  overviewSystemQualityDomainSchema,
} from "../../../src/shared/schemas/overview.schema.js";
import { buildGraphSnapshot } from "../graph/graph.repository.js";
import {
  DASHBOARD_TIMEZONE,
  LLM_KPI_DAY_RANGE,
  OVERVIEW_DAY_RANGE,
  buildCommunitySourceCoverage,
  buildDistillationQueueChart,
  buildKnowledgeStatusTypeChart,
  buildOverviewLandscapeSummary,
  checkedAt,
  countWikiPages,
  latestCheckedAt,
  normalizeSearchApiStatus,
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

export async function fetchOverviewKnowledgeAssetsDomainForApi(): Promise<OverviewKnowledgeAssetsDomain> {
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
          current_date - (${OVERVIEW_DAY_RANGE - 1} * interval '1 day'),
          current_date,
          interval '1 day'
        )::date as day
      ),
      daily_records as (
        select
          date_trunc('day', created_at)::date as day,
          count(*)::int as records
        from vibe_memories
        where created_at >= current_date - (${OVERVIEW_DAY_RANGE - 1} * interval '1 day')
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

export async function fetchOverviewSystemQualityDomainForApi(): Promise<OverviewSystemQualityDomain> {
  await ensureRuntimeSettingsLoaded();
  const db = getDb();

  const [
    compileSummaryResult,
    compileRunsByDayResult,
    distillationQueueResult,
    searchProviderStateResult,
    compileRunHealthResult,
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
          current_date - (${OVERVIEW_DAY_RANGE - 1} * interval '1 day'),
          current_date,
          interval '1 day'
        )::date as day
      ),
      daily_runs as (
        select
          date_trunc('day', created_at)::date as day,
          count(*) filter (where status = 'ok')::int as ok,
          count(*) filter (where status = 'degraded')::int as degraded,
          count(*) filter (where status = 'failed')::int as failed,
          avg(duration_ms)::float as avg_duration_ms
        from context_compile_runs
        where created_at >= current_date - (${OVERVIEW_DAY_RANGE - 1} * interval '1 day')
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
      select
        target_kind,
        count(*) filter (where status = 'pending')::int as pending,
        count(*) filter (where status = 'running')::int as running,
        count(*) filter (where status = 'paused')::int as paused,
        count(*) filter (where status = 'completed')::int as completed,
        count(*) filter (where status = 'failed')::int as failed
      from distillation_target_states
      where distillation_version = ${APP_CONSTANTS.distillationTargetVersion}
      group by target_kind
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
  ]);

  const compileSummaryRow = (compileSummaryResult.rows[0] ?? {}) as Record<string, unknown>;
  const searchProviderStateRow = (searchProviderStateResult.rows[0] ?? {}) as Record<
    string,
    unknown
  >;

  const domain: OverviewSystemQualityDomain = {
    checkedAt: checkedAt(),
    kpis: {
      compileRuns: toNumber(compileSummaryRow.compile_runs),
      compileOkRuns: toNumber(compileSummaryRow.compile_ok_runs),
      compileDegradedRuns: toNumber(compileSummaryRow.compile_degraded_runs),
      compileFailedRuns: toNumber(compileSummaryRow.compile_failed_runs),
    },
    compileRunHealth: compileRunHealthResult.runs,
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
      distillationQueue: buildDistillationQueueChart(
        distillationQueueResult.rows as Array<Record<string, unknown>>,
      ),
    },
    searchApiStatus: normalizeSearchApiStatus(searchProviderStateRow.metadata),
  };

  return overviewSystemQualityDomainSchema.parse(domain);
}

export async function fetchOverviewLlmResourcesDomainForApi(): Promise<OverviewLlmResourcesDomain> {
  await ensureRuntimeSettingsLoaded();
  const db = getDb();

  const [llmUsageKpisResult, llmUsageByDayResult, llmUsageBySourceResult] = await Promise.all([
    db.execute(sql`
      with jst_anchor as (
        select (now() at time zone ${DASHBOARD_TIMEZONE})::date as jst_today
      ),
      window_usage as (
        select *
        from llm_usage_logs
        where (created_at + interval '9 hours')::date >=
          ((select jst_today from jst_anchor) - (${LLM_KPI_DAY_RANGE - 1} * interval '1 day'))
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
      with jst_anchor as (
        select (now() at time zone ${DASHBOARD_TIMEZONE})::date as jst_today
      ),
      days as (
        select generate_series(
          (select jst_today from jst_anchor) - (${OVERVIEW_DAY_RANGE - 1} * interval '1 day'),
          (select jst_today from jst_anchor),
          interval '1 day'
        )::date as day
      ),
      daily_usage as (
        select
          (created_at + interval '9 hours')::date as day,
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
        where (created_at + interval '9 hours')::date >=
          ((select jst_today from jst_anchor) - (${OVERVIEW_DAY_RANGE - 1} * interval '1 day'))
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
      with jst_anchor as (
        select (now() at time zone ${DASHBOARD_TIMEZONE})::date as jst_today
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
      where (created_at + interval '9 hours')::date >=
        ((select jst_today from jst_anchor) - (${LLM_KPI_DAY_RANGE - 1} * interval '1 day'))
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

export async function fetchOverviewLandscapeHealthDomainForApi(): Promise<OverviewLandscapeHealthDomain> {
  await ensureRuntimeSettingsLoaded();
  const domain: OverviewLandscapeHealthDomain = {
    checkedAt: checkedAt(),
    landscape: await buildOverviewLandscapeSummary(),
  };
  return overviewLandscapeHealthDomainSchema.parse(domain);
}

export async function fetchOverviewDomainForApi(
  domain: OverviewDomainName,
): Promise<OverviewDomainPayload> {
  if (domain === "knowledge-assets") return fetchOverviewKnowledgeAssetsDomainForApi();
  if (domain === "landscape-health") return fetchOverviewLandscapeHealthDomainForApi();
  if (domain === "system-quality") return fetchOverviewSystemQualityDomainForApi();
  return fetchOverviewLlmResourcesDomainForApi();
}

export async function fetchOverviewDashboardForApi(): Promise<OverviewDashboard> {
  const [knowledgeAssets, landscapeHealth, systemQuality, llmResources] = await Promise.all([
    fetchOverviewKnowledgeAssetsDomainForApi(),
    fetchOverviewLandscapeHealthDomainForApi(),
    fetchOverviewSystemQualityDomainForApi(),
    fetchOverviewLlmResourcesDomainForApi(),
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
    landscape: landscapeHealth.landscape,
  };

  return overviewDashboardSchema.parse(dashboard);
}
