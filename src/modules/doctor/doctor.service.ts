import { sql } from "drizzle-orm";
import { config } from "../../config.js";
import { getDb } from "../../db/index.js";
import { type DoctorReport, doctorReportSchema } from "../../shared/schemas/doctor.schema.js";
import { listRecentCompileRuns } from "../context-compiler/context-compiler.repository.js";

const requiredTables = [
  "knowledge_items",
  "evidence_sources",
  "evidence_fragments",
  "relations",
  "context_compile_runs",
  "context_pack_items",
  "code_symbols",
] as const;

type DoctorOptions = {
  windowSize?: number;
  freshnessThresholdMinutes?: number;
  degradedRateThreshold?: number;
};

function nowIso(): string {
  return new Date().toISOString();
}

function minutesSince(iso: string): number {
  const deltaMs = Date.now() - new Date(iso).getTime();
  return Math.max(0, deltaMs / 1000 / 60);
}

export async function runDoctor(rawOptions?: DoctorOptions): Promise<DoctorReport> {
  const db = getDb();
  const options = {
    windowSize: Math.max(1, rawOptions?.windowSize ?? 20),
    freshnessThresholdMinutes:
      rawOptions?.freshnessThresholdMinutes ?? config.doctorFreshnessThresholdMinutes,
    degradedRateThreshold: rawOptions?.degradedRateThreshold ?? config.doctorDegradedRateThreshold,
  };

  const reasons: string[] = [];
  const startedAt = Date.now();

  try {
    await db.execute(sql`select 1 as ok`);
  } catch (error) {
    return doctorReportSchema.parse({
      status: "failed",
      checkedAt: nowIso(),
      reasons: ["DB_UNREACHABLE"],
      db: {
        reachable: false,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      },
      vector: { installed: false },
      tables: { expected: [...requiredTables], existing: [], missing: [...requiredTables] },
      runs: {
        windowSize: options.windowSize,
        totalRuns: 0,
        degradedRuns: 0,
        degradedRate: 0,
        lastRunAt: null,
        lastRunAgeMinutes: null,
        freshnessThresholdMinutes: options.freshnessThresholdMinutes,
        degradedRateThreshold: options.degradedRateThreshold,
      },
    });
  }

  const dbDurationMs = Date.now() - startedAt;

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
          'knowledge_items',
          'evidence_sources',
          'evidence_fragments',
          'relations',
          'context_compile_runs',
          'context_pack_items',
          'code_symbols'
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

  let totalRuns = 0;
  let degradedRuns = 0;
  let degradedRate = 0;
  let lastRunAt: string | null = null;
  let lastRunAgeMinutes: number | null = null;

  if (missingTables.includes("context_compile_runs")) {
    reasons.push("RUN_HEALTH_SKIPPED_TABLE_MISSING");
  } else {
    try {
      const recentRuns = await listRecentCompileRuns(options.windowSize);
      totalRuns = recentRuns.length;
      degradedRuns = recentRuns.filter(
        (run) => run.status === "degraded" || run.status === "failed",
      ).length;
      degradedRate = totalRuns > 0 ? degradedRuns / totalRuns : 0;
      lastRunAt = recentRuns[0]?.createdAt ? recentRuns[0].createdAt.toISOString() : null;
      lastRunAgeMinutes = lastRunAt ? minutesSince(lastRunAt) : null;

      if (totalRuns === 0) {
        reasons.push("NO_COMPILE_RUN_HISTORY");
      }
      if (lastRunAgeMinutes !== null && lastRunAgeMinutes > options.freshnessThresholdMinutes) {
        reasons.push("CONTEXT_COMPILE_STALE");
      }
      if (degradedRate > options.degradedRateThreshold) {
        reasons.push("DEGRADED_RATE_HIGH");
      }
    } catch {
      reasons.push("RUN_HEALTH_QUERY_FAILED");
    }
  }

  const status =
    reasons.includes("MISSING_REQUIRED_TABLES") || reasons.includes("REQUIRED_TABLES_CHECK_FAILED")
      ? "failed"
      : reasons.length > 0
        ? "degraded"
        : "ok";

  return doctorReportSchema.parse({
    status,
    checkedAt: nowIso(),
    reasons,
    db: {
      reachable: true,
      durationMs: dbDurationMs,
    },
    vector: {
      installed: vectorInstalled,
    },
    tables: {
      expected: [...requiredTables],
      existing: existingTables,
      missing: missingTables,
    },
    runs: {
      windowSize: options.windowSize,
      totalRuns,
      degradedRuns,
      degradedRate,
      lastRunAt,
      lastRunAgeMinutes,
      freshnessThresholdMinutes: options.freshnessThresholdMinutes,
      degradedRateThreshold: options.degradedRateThreshold,
    },
  });
}
