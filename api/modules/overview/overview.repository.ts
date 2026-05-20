import { sql } from "drizzle-orm";
import { groupedConfig } from "../../../src/config.js";
import { APP_CONSTANTS } from "../../../src/constants.js";
import { getDb } from "../../../src/db/index.js";
import { ensureContentRoot, listPages } from "../../../src/modules/sources/wiki/content-repo.js";
import {
  overviewDashboardSchema,
  type OverviewDashboard,
} from "../../../src/shared/schemas/overview.schema.js";

const OVERVIEW_DAY_RANGE = 14;
const KNOWLEDGE_STATUS_ORDER = ["active", "draft", "deprecated"] as const;
const DISTILLATION_TARGET_KIND_ORDER = ["wiki_file", "vibe_memory"] as const;

function toNumber(value: unknown, fallback = 0): number {
  const converted = Number(value);
  return Number.isFinite(converted) ? converted : fallback;
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const converted = Number(value);
  return Number.isFinite(converted) ? converted : null;
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
  ]);

  await ensureContentRoot(groupedConfig.sourceContent.root);
  const wikiPages = (await listPages(groupedConfig.sourceContent.root)).length;

  const knowledgeSummaryRow = (knowledgeSummaryResult.rows[0] ?? {}) as Record<string, unknown>;
  const sourceSummaryRow = (sourceSummaryResult.rows[0] ?? {}) as Record<string, unknown>;
  const vibeSummaryRow = (vibeSummaryResult.rows[0] ?? {}) as Record<string, unknown>;
  const compileSummaryRow = (compileSummaryResult.rows[0] ?? {}) as Record<string, unknown>;
  const dynamicScoreBucketRow = (dynamicScoreBucketResult.rows[0] ?? {}) as Record<string, unknown>;

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
  };

  return overviewDashboardSchema.parse(dashboard);
}
