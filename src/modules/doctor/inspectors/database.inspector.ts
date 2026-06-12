import { sql } from "drizzle-orm";
import { groupedConfig } from "../../../config.js";
import { getDb } from "../../../db/index.js";
import type { DoctorReport } from "../../../shared/schemas/doctor.schema.js";
import { requiredTableSqlList, requiredTables } from "../doctor.constants.js";

type DatabaseInspectorOptions = {
  freshnessThresholdMinutes: number;
  staleDecayFactor: number;
  zeroUseWarningMinActiveCount: number;
};

const hitlBacklogThresholdCount = groupedConfig.distillation.promotionBacklogThresholdCount;
const hitlBacklogThresholdAgeMinutes = 60 * 24 * 3;

function toIso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

function ageMinutesFromIso(value: string | null): number | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return null;
  return Math.max(0, Math.round((Date.now() - timestamp) / 60000));
}

export type DatabaseInspection = {
  db: DoctorReport["db"];
  reachable: boolean;
  vectorInstalled: boolean;
  existingTables: string[];
  missingTables: string[];
  staleKnowledgeCount: number;
  staleSourceCount: number;
  hitl: DoctorReport["hitl"];
  knowledgeLifecycle: DoctorReport["knowledgeLifecycle"];
  reasons: string[];
};

function createDefaultKnowledgeLifecycle(
  options: Pick<DatabaseInspectorOptions, "staleDecayFactor" | "zeroUseWarningMinActiveCount">,
): DoctorReport["knowledgeLifecycle"] {
  return {
    activeCount: 0,
    zeroUseActiveCount: 0,
    staleByDecayCount: 0,
    staleProcedureCount: 0,
    dynamicScoreAvg: null,
    dynamicScoreP95: null,
    lastCompiledAt: null,
    lastCompiledAgeMinutes: null,
    thresholds: {
      staleDecayFactor: options.staleDecayFactor,
      zeroUseWarningMinActiveCount: options.zeroUseWarningMinActiveCount,
    },
  };
}

export async function inspectDatabase({
  freshnessThresholdMinutes,
  staleDecayFactor,
  zeroUseWarningMinActiveCount,
}: DatabaseInspectorOptions): Promise<DatabaseInspection> {
  const db = getDb();
  const startedAt = Date.now();

  try {
    await db.execute(sql`select 1 as ok`);
  } catch (error) {
    return {
      db: {
        reachable: false,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      },
      reachable: false,
      vectorInstalled: false,
      existingTables: [],
      missingTables: [...requiredTables],
      staleKnowledgeCount: 0,
      staleSourceCount: 0,
      hitl: {
        draftCount: 0,
        oldestDraftAt: null,
        oldestDraftAgeMinutes: null,
        backlogThresholdCount: hitlBacklogThresholdCount,
        backlogThresholdAgeMinutes: hitlBacklogThresholdAgeMinutes,
      },
      knowledgeLifecycle: createDefaultKnowledgeLifecycle({
        staleDecayFactor,
        zeroUseWarningMinActiveCount,
      }),
      reasons: ["DB_UNREACHABLE"],
    };
  }

  const reasons: string[] = [];

  let vectorInstalled = false;
  try {
    const result = await db.execute(
      sql`select exists(select 1 from pg_extension where extname = 'vector') as installed`,
    );
    vectorInstalled = Boolean((result.rows as Array<{ installed: boolean }>)[0]?.installed);
    if (!vectorInstalled) {
      reasons.push("VECTOR_EXTENSION_MISSING");
    }
  } catch {
    reasons.push("VECTOR_EXTENSION_CHECK_FAILED");
  }

  let existingTables: string[] = [];
  try {
    const result = await db.execute(sql`
      select table_name
      from information_schema.tables
      where table_schema = 'public'
        and table_name in (
          ${sql.raw(requiredTableSqlList)}
        )
    `);
    existingTables = (result.rows as Array<{ table_name: string }>).map((row) => row.table_name);
  } catch {
    reasons.push("REQUIRED_TABLES_CHECK_FAILED");
  }

  const missingTables = requiredTables.filter((tableName) => !existingTables.includes(tableName));
  if (missingTables.length > 0) {
    reasons.push("MISSING_REQUIRED_TABLES");
  }

  let staleKnowledgeCount = 0;
  let staleSourceCount = 0;
  const hitl: DoctorReport["hitl"] = {
    draftCount: 0,
    oldestDraftAt: null,
    oldestDraftAgeMinutes: null,
    backlogThresholdCount: hitlBacklogThresholdCount,
    backlogThresholdAgeMinutes: hitlBacklogThresholdAgeMinutes,
  };
  const knowledgeLifecycle = createDefaultKnowledgeLifecycle({
    staleDecayFactor,
    zeroUseWarningMinActiveCount,
  });

  if (!missingTables.includes("knowledge_items")) {
    try {
      const result = await db.execute(sql`
        select count(*)::int as count
        from knowledge_items
        where status = 'deprecated'
      `);
      staleKnowledgeCount = Number((result.rows as Array<{ count?: number }>)[0]?.count ?? 0);
    } catch {
      reasons.push("STALE_KNOWLEDGE_COUNT_QUERY_FAILED");
    }

    try {
      const draftResult = await db.execute(sql`
        select
          count(*) filter (where status = 'draft')::int as draft_count,
          min(case when status = 'draft' then updated_at end) as oldest_draft_at
        from knowledge_items
      `);
      const draftRow = (draftResult.rows as Array<Record<string, unknown>>)[0] ?? {};
      hitl.draftCount = Number(draftRow.draft_count ?? 0);
      hitl.oldestDraftAt = toIso(draftRow.oldest_draft_at);
      hitl.oldestDraftAgeMinutes = ageMinutesFromIso(hitl.oldestDraftAt);
      if (hitl.draftCount > hitl.backlogThresholdCount) {
        reasons.push("HITL_DRAFT_BACKLOG_HIGH");
      }
      if (
        hitl.oldestDraftAgeMinutes !== null &&
        hitl.oldestDraftAgeMinutes > hitl.backlogThresholdAgeMinutes
      ) {
        reasons.push("HITL_DRAFT_REVIEW_STALE");
      }
    } catch {
      reasons.push("HITL_BACKLOG_QUERY_FAILED");
    }

    try {
      const lifecycleResult = await db.execute(sql`
        with active_items as (
          select
            status,
            type,
            scope,
            compile_select_count,
            dynamic_score,
            last_compiled_at,
            coalesce(last_verified_at, updated_at) as freshness_base
          from knowledge_items
          where status = 'active'
        ),
        scored as (
          select
            *,
            exp(
              -(
                (case when type = 'procedure' then 0.004 else 0.001 end) *
                (case when scope = 'global' then 0.5 else 1.0 end) *
                greatest(0, extract(epoch from (now() - freshness_base)) / 86400.0)
              )
            ) as decay_factor
          from active_items
        )
        select
          count(*)::int as active_count,
          count(*) filter (where compile_select_count = 0)::int as zero_use_active_count,
          count(*) filter (where decay_factor < ${staleDecayFactor})::int as stale_by_decay_count,
          count(*) filter (
            where type = 'procedure' and decay_factor < ${staleDecayFactor}
          )::int as stale_procedure_count,
          avg(dynamic_score)::float as dynamic_score_avg,
          percentile_cont(0.95) within group (order by dynamic_score)::float as dynamic_score_p95,
          max(last_compiled_at) as last_compiled_at
        from scored
      `);
      const lifecycleRow = (lifecycleResult.rows as Array<Record<string, unknown>>)[0] ?? {};

      knowledgeLifecycle.activeCount = Number(lifecycleRow.active_count ?? 0);
      knowledgeLifecycle.zeroUseActiveCount = Number(lifecycleRow.zero_use_active_count ?? 0);
      knowledgeLifecycle.staleByDecayCount = Number(lifecycleRow.stale_by_decay_count ?? 0);
      knowledgeLifecycle.staleProcedureCount = Number(lifecycleRow.stale_procedure_count ?? 0);

      const dynamicScoreAvgRaw = lifecycleRow.dynamic_score_avg;
      const dynamicScoreP95Raw = lifecycleRow.dynamic_score_p95;
      knowledgeLifecycle.dynamicScoreAvg =
        dynamicScoreAvgRaw === null || dynamicScoreAvgRaw === undefined
          ? null
          : Number(dynamicScoreAvgRaw);
      knowledgeLifecycle.dynamicScoreP95 =
        dynamicScoreP95Raw === null || dynamicScoreP95Raw === undefined
          ? null
          : Number(dynamicScoreP95Raw);

      knowledgeLifecycle.lastCompiledAt = toIso(lifecycleRow.last_compiled_at);
      knowledgeLifecycle.lastCompiledAgeMinutes = ageMinutesFromIso(
        knowledgeLifecycle.lastCompiledAt,
      );

      if (
        knowledgeLifecycle.activeCount >= zeroUseWarningMinActiveCount &&
        knowledgeLifecycle.zeroUseActiveCount / Math.max(1, knowledgeLifecycle.activeCount) >= 0.7
      ) {
        reasons.push("KNOWLEDGE_ZERO_USE_HIGH");
      }
      if (knowledgeLifecycle.staleByDecayCount >= 10) {
        reasons.push("KNOWLEDGE_DECAY_STALE_HIGH");
      }
    } catch {
      reasons.push("KNOWLEDGE_VALUE_QUERY_FAILED");
    }

    try {
      const unknownTagsResult = await db.execute(sql`
        select count(*)::int as count
        from knowledge_items,
             jsonb_array_elements_text(intent_tags) as tag
        where tag not in (
          'guidance', 'guardrail', 'prohibition', 'warning', 'failure_pattern',
          'review_finding', 'regression', 'test_gap', 'verification', 'preference',
          'boundary_violation', 'architecture_risk', 'security_risk', 'performance_risk',
          'operational_risk'
        )
      `);
      const unknownTagsCount = Number(
        (unknownTagsResult.rows as Array<{ count?: number }>)[0]?.count ?? 0,
      );
      if (unknownTagsCount > 0) {
        reasons.push("KNOWLEDGE_UNKNOWN_INTENT_TAGS");
      }

      const negativeWithoutOriginResult = await db.execute(sql`
        select count(*)::int as count
        from knowledge_items
        where polarity = 'negative'
          and id not in (select knowledge_id from knowledge_origin_links)
          and id not in (select knowledge_id from knowledge_source_links)
      `);
      const negativeWithoutOriginCount = Number(
        (negativeWithoutOriginResult.rows as Array<{ count?: number }>)[0]?.count ?? 0,
      );
      if (negativeWithoutOriginCount > 0) {
        reasons.push("KNOWLEDGE_NEGATIVE_WITHOUT_ORIGIN");
      }

      const negativeAsPositiveResult = await db.execute(sql`
        select count(*)::int as count
        from knowledge_items
        where polarity = 'negative' and type = 'procedure'
      `);
      const negativeAsPositiveCount = Number(
        (negativeAsPositiveResult.rows as Array<{ count?: number }>)[0]?.count ?? 0,
      );
      if (negativeAsPositiveCount > 0) {
        reasons.push("KNOWLEDGE_NEGATIVE_AS_POSITIVE");
      }
    } catch {
      // 非ブロッキング
    }
  }

  // sources は時間経過で stale と判定する必要がないため、検出を廃止します。
  staleSourceCount = 0;

  if (!missingTables.includes("audit_logs")) {
    try {
      const result = await db.execute(sql`
        select count(*)::int as count
        from audit_logs
        where event_type = 'KNOWLEDGE_VALUE_UPDATE_FAILED'
          and created_at >= now() - (${freshnessThresholdMinutes} * interval '1 minute')
      `);
      const recentFailureCount = Number((result.rows as Array<{ count?: number }>)[0]?.count ?? 0);
      if (recentFailureCount > 0 && !reasons.includes("KNOWLEDGE_VALUE_UPDATE_FAILED")) {
        reasons.push("KNOWLEDGE_VALUE_UPDATE_FAILED");
      }
    } catch {
      if (!reasons.includes("KNOWLEDGE_VALUE_QUERY_FAILED")) {
        reasons.push("KNOWLEDGE_VALUE_QUERY_FAILED");
      }
    }
  }

  return {
    db: {
      reachable: true,
      durationMs: Date.now() - startedAt,
    },
    reachable: true,
    vectorInstalled,
    existingTables,
    missingTables,
    staleKnowledgeCount,
    staleSourceCount,
    hitl,
    knowledgeLifecycle,
    reasons,
  };
}
