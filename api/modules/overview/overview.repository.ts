import { sql } from "drizzle-orm";
import { groupedConfig } from "../../../src/config.js";
import { APP_CONSTANTS } from "../../../src/constants.js";
import { getDb } from "../../../src/db/index.js";
import type {
  SearchProviderName,
  SearchProviderRateLimit,
} from "../../../src/modules/distillation/search-providers.js";
import { deriveSearchProviderCooldownUntil } from "../../../src/modules/distillation/search-rate-limit.js";
import { resolveCostRate } from "../../../src/modules/llm/llm-cost-config.js";
import { ensureContentRoot, listPages } from "../../../src/modules/sources/wiki/content-repo.js";
import {
  type OverviewDashboard,
  overviewDashboardSchema,
} from "../../../src/shared/schemas/overview.schema.js";

const OVERVIEW_DAY_RANGE = 14;
const LLM_KPI_DAY_RANGE = 30;
const DASHBOARD_TIMEZONE = "Asia/Tokyo";
const KNOWLEDGE_STATUS_ORDER = ["active", "draft", "deprecated"] as const;
const DISTILLATION_TARGET_KIND_ORDER = ["knowledge_candidate", "wiki_file", "vibe_memory"] as const;

function toNumber(value: unknown, fallback = 0): number {
  const converted = Number(value);
  return Number.isFinite(converted) ? converted : fallback;
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const converted = Number(value);
  return Number.isFinite(converted) ? converted : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRateLimitedStatus(value: unknown): boolean {
  if (typeof value === "number") {
    return value === 429;
  }
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "429" || normalized === "cooldown" || normalized === "rate_limited";
}

function hasUnknownCooldownSignal(entry: Record<string, unknown>): boolean {
  const lastRateLimit = isRecord(entry.lastRateLimit) ? entry.lastRateLimit : {};
  const lastError = stringValue(entry.lastError)?.toLowerCase() ?? "";
  return (
    isRateLimitedStatus(entry.status) ||
    isRateLimitedStatus(lastRateLimit.status) ||
    lastError.includes("429") ||
    lastError.includes("rate limit") ||
    lastError.includes("rate-limit")
  );
}

function isoDateTimeValue(value: unknown): string | null {
  const raw = stringValue(value);
  if (!raw) return null;
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function latestFutureIso(values: Array<string | null>, now: number): string | null {
  const futureTimes = values
    .flatMap((value) => {
      if (!value) return [];
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) && parsed > now ? [parsed] : [];
    })
    .sort((a, b) => b - a);
  return futureTimes[0] ? new Date(futureTimes[0]).toISOString() : null;
}

export function normalizeSearchApiStatus(metadata: unknown): OverviewDashboard["searchApiStatus"] {
  const root = isRecord(metadata)
    ? isRecord(metadata.providers)
      ? metadata.providers
      : metadata
    : {};
  const now = Date.now();

  const normalizeProvider = (provider: "brave" | "exa") => {
    const entry = isRecord(root[provider]) ? root[provider] : {};
    const storedCooldownUntil = isoDateTimeValue(entry.cooldownUntil);
    const rateLimitCooldownUntil = deriveSearchProviderCooldownUntil({
      provider: provider as SearchProviderName,
      rateLimit: isRecord(entry.lastRateLimit)
        ? (entry.lastRateLimit as SearchProviderRateLimit)
        : undefined,
      updatedAt: isoDateTimeValue(entry.updatedAt),
      nowMs: now,
    });
    const cooldownUntil = latestFutureIso([storedCooldownUntil, rateLimitCooldownUntil], now);
    const cooldownActive = cooldownUntil !== null || hasUnknownCooldownSignal(entry);
    return {
      status: cooldownActive ? ("cooldown" as const) : ("ok" as const),
      cooldownUntil: cooldownActive ? cooldownUntil : null,
      lastError: stringValue(entry.lastError),
    };
  };

  return {
    brave: normalizeProvider("brave"),
    exa: normalizeProvider("exa"),
  };
}

export async function fetchOverviewDashboardForApi(): Promise<OverviewDashboard> {
  const db = getDb();

  const [
    knowledgeSummaryResult,
    sourceSummaryResult,
    vibeSummaryResult,
    compileSummaryResult,
    knowledgeByStatusTypeResult,
    dynamicScoreBucketResult,
    compileRunsByDayResult,
    vibeRecordsByDayResult,
    distillationQueueResult,
    llmUsageKpisResult,
    llmUsageByDayResult,
    llmUsageBySourceResult,
    searchProviderStateResult,
  ] = await Promise.all([
    db.execute(sql`
      with linked as (
        select distinct knowledge_id
        from knowledge_source_links
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
        coalesce((select count(*)::int from linked), 0)::int as linked_knowledge
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
        count(*)::int as compile_runs,
        count(*) filter (where status = 'ok')::int as compile_ok_runs,
        count(*) filter (where status = 'degraded')::int as compile_degraded_runs,
        count(*) filter (where status = 'failed')::int as compile_failed_runs
      from context_compile_runs
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
        count(*) filter (where dynamic_score > 10)::int as bucket_10_plus
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
    db.execute(sql`
      select metadata
      from sync_states
      where id = 'distillation_search_providers'
      limit 1
    `),
  ]);

  await ensureContentRoot(groupedConfig.sourceContent.root);
  const wikiPages = (await listPages(groupedConfig.sourceContent.root)).length;

  const knowledgeSummaryRow = (knowledgeSummaryResult.rows[0] ?? {}) as Record<string, unknown>;
  const sourceSummaryRow = (sourceSummaryResult.rows[0] ?? {}) as Record<string, unknown>;
  const vibeSummaryRow = (vibeSummaryResult.rows[0] ?? {}) as Record<string, unknown>;
  const compileSummaryRow = (compileSummaryResult.rows[0] ?? {}) as Record<string, unknown>;
  const dynamicScoreBucketRow = (dynamicScoreBucketResult.rows[0] ?? {}) as Record<string, unknown>;
  const llmUsageKpiRow = (llmUsageKpisResult.rows[0] ?? {}) as Record<string, unknown>;
  const llmUsageTotalCalls = toNumber(llmUsageKpiRow.total_calls_30d);
  const llmUsageMeasuredCalls = toNumber(llmUsageKpiRow.measured_calls_30d);
  const cloudModel =
    stringValue(llmUsageKpiRow.cloud_model_30d) ??
    stringValue(groupedConfig.azureOpenAi.model) ??
    "default-cloud";
  const cloudCostRate = resolveCostRate(cloudModel);
  const searchProviderStateRow = (searchProviderStateResult.rows[0] ?? {}) as Record<
    string,
    unknown
  >;

  const knowledgeTotal = toNumber(knowledgeSummaryRow.knowledge_total);
  const linkedKnowledge = toNumber(knowledgeSummaryRow.linked_knowledge);
  const compileRuns = toNumber(compileSummaryRow.compile_runs);
  const compileDegradedRuns = toNumber(compileSummaryRow.compile_degraded_runs);
  const compileOkRuns = toNumber(compileSummaryRow.compile_ok_runs);
  const compileFailedRuns = toNumber(compileSummaryRow.compile_failed_runs);
  const zeroUseActiveKnowledge = toNumber(knowledgeSummaryRow.zero_use_active_knowledge);
  const activeKnowledge = toNumber(knowledgeSummaryRow.active_knowledge);

  const statusTypeMap = new Map<string, { rule: number; procedure: number }>();
  for (const status of KNOWLEDGE_STATUS_ORDER) {
    statusTypeMap.set(status, { rule: 0, procedure: 0 });
  }
  for (const row of knowledgeByStatusTypeResult.rows as Array<Record<string, unknown>>) {
    const status = typeof row.status === "string" ? row.status : "";
    const type = typeof row.type === "string" ? row.type : "";
    if (!statusTypeMap.has(status)) continue;
    const counts = statusTypeMap.get(status);
    if (!counts) continue;
    if (type === "rule") counts.rule = toNumber(row.item_count);
    if (type === "procedure") counts.procedure = toNumber(row.item_count);
  }

  const distillationQueueMap = new Map<string, Record<string, unknown>>();
  for (const row of distillationQueueResult.rows as Array<Record<string, unknown>>) {
    const targetKind = typeof row.target_kind === "string" ? row.target_kind : "";
    if (!targetKind) continue;
    distillationQueueMap.set(targetKind, row);
  }

  const dashboard: OverviewDashboard = {
    checkedAt: new Date().toISOString(),
    kpis: {
      knowledgeTotal,
      activeKnowledge,
      draftKnowledge: toNumber(knowledgeSummaryRow.draft_knowledge),
      deprecatedKnowledge: toNumber(knowledgeSummaryRow.deprecated_knowledge),
      rules: toNumber(knowledgeSummaryRow.rules),
      procedures: toNumber(knowledgeSummaryRow.procedures),
      embeddedKnowledge: toNumber(knowledgeSummaryRow.embedded_knowledge),
      zeroUseActiveKnowledge,
      wikiPages,
      indexedSources: toNumber(sourceSummaryRow.indexed_sources),
      sourceFragments: toNumber(sourceSummaryRow.source_fragments),
      sourceLinks: toNumber(sourceSummaryRow.source_links),
      linkedKnowledge,
      unlinkedKnowledge: Math.max(0, knowledgeTotal - linkedKnowledge),
      vibeRecords: toNumber(vibeSummaryRow.vibe_records),
      vibeSessions: toNumber(vibeSummaryRow.vibe_sessions),
      vibeRecordsWithDiffs: toNumber(vibeSummaryRow.vibe_records_with_diffs),
      agentDiffEntries: toNumber(vibeSummaryRow.agent_diff_entries),
      compileRuns,
      compileOkRuns,
      compileDegradedRuns,
      compileFailedRuns,
    },
    charts: {
      knowledgeByStatusType: KNOWLEDGE_STATUS_ORDER.map((status) => ({
        status,
        rule: statusTypeMap.get(status)?.rule ?? 0,
        procedure: statusTypeMap.get(status)?.procedure ?? 0,
      })),
      dynamicScoreBuckets: [
        { bucket: "0", count: toNumber(dynamicScoreBucketRow.bucket_0) },
        { bucket: "0-1", count: toNumber(dynamicScoreBucketRow.bucket_0_1) },
        { bucket: "1-5", count: toNumber(dynamicScoreBucketRow.bucket_1_5) },
        { bucket: "5-10", count: toNumber(dynamicScoreBucketRow.bucket_5_10) },
        { bucket: "10+", count: toNumber(dynamicScoreBucketRow.bucket_10_plus) },
      ],
      compileRunsByDay: (compileRunsByDayResult.rows as Array<Record<string, unknown>>).map(
        (row) => ({
          day: String(row.day ?? ""),
          ok: toNumber(row.ok),
          degraded: toNumber(row.degraded),
          failed: toNumber(row.failed),
          avgDurationMs: toNullableNumber(row.avg_duration_ms),
        }),
      ),
      vibeRecordsByDay: (vibeRecordsByDayResult.rows as Array<Record<string, unknown>>).map(
        (row) => ({
          day: String(row.day ?? ""),
          records: toNumber(row.records),
        }),
      ),
      sourceCoverage: [
        { label: "linked", count: linkedKnowledge },
        { label: "unlinked", count: Math.max(0, knowledgeTotal - linkedKnowledge) },
      ],
      distillationQueue: DISTILLATION_TARGET_KIND_ORDER.map((targetKind) => {
        const row = distillationQueueMap.get(targetKind);
        return {
          targetKind,
          pending: toNumber(row?.pending),
          running: toNumber(row?.running),
          paused: toNumber(row?.paused),
          completed: toNumber(row?.completed),
          failed: toNumber(row?.failed),
        };
      }),
    },
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
    searchApiStatus: normalizeSearchApiStatus(searchProviderStateRow.metadata),
  };

  return overviewDashboardSchema.parse(dashboard);
}
