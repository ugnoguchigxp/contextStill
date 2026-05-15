import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { config } from "../../config.js";
import { getDb } from "../../db/index.js";
import { syncStates } from "../../db/schema.js";
import { type DoctorReport, doctorReportSchema } from "../../shared/schemas/doctor.schema.js";
import { listRecentCompileRuns } from "../context-compiler/context-compiler.repository.js";
import { embeddingHealth } from "../embedding/embedding.service.js";

const requiredTables = [
  "knowledge_items",
  "sources",
  "source_fragments",
  "knowledge_source_links",
  "vibe_memories",
  "agent_diff_entries",
  "relations",
  "context_compile_runs",
  "context_pack_items",
  "sync_states",
] as const;

const requiredTableSqlList = requiredTables.map((tableName) => `'${tableName}'`).join(", ");

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

async function pathExists(filePath: string): Promise<boolean> {
  if (!filePath.trim()) return false;
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function cursorFileCount(raw: unknown): number {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return 0;
  return Object.keys(raw).length;
}

function metadataWarnings(raw: unknown): string[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const warnings = (raw as { warnings?: unknown }).warnings;
  if (!Array.isArray(warnings)) return [];
  return warnings.filter((warning): warning is string => typeof warning === "string");
}

function metadataSkipped(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  return Boolean((raw as { skipped?: unknown }).skipped);
}

async function inspectLaunchAgent(): Promise<DoctorReport["agentLogSync"]["launchAgent"]> {
  const label = "com.memory-router.agent-log-sync";
  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
  const installed = await pathExists(plistPath);
  let loaded = false;
  let state: string | null = null;

  if (installed && typeof process.getuid === "function") {
    try {
      const output = execFileSync("launchctl", ["print", `gui/${process.getuid()}/${label}`], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      loaded = true;
      state = output.match(/state = ([^\n]+)/)?.[1]?.trim() ?? null;
    } catch {
      loaded = false;
    }
  }

  return { label, plistPath, installed, loaded, state };
}

async function inspectAgentLogSync(params: {
  canQueryDb: boolean;
  syncStatesTableAvailable: boolean;
}): Promise<DoctorReport["agentLogSync"]> {
  const codexSessionDirExists = await pathExists(config.codexSessionDir);
  const codexArchivedSessionDirExists = await pathExists(config.codexArchivedSessionDir);
  const antigravityConfigured = config.antigravityLogDir.trim().length > 0;
  const antigravityExists = antigravityConfigured
    ? await pathExists(config.antigravityLogDir)
    : false;
  const launchAgent = await inspectLaunchAgent();
  const states: DoctorReport["agentLogSync"]["states"] = [];

  if (params.canQueryDb && params.syncStatesTableAvailable) {
    try {
      const rows = await getDb().select().from(syncStates);
      for (const row of rows) {
        const lastSyncedAt = row.lastSyncedAt?.toISOString() ?? null;
        states.push({
          id: row.id,
          lastSyncedAt,
          lastSyncedAgeMinutes: lastSyncedAt ? minutesSince(lastSyncedAt) : null,
          cursorFiles: cursorFileCount(row.cursor),
          skipped: metadataSkipped(row.metadata),
          warnings: metadataWarnings(row.metadata),
        });
      }
    } catch {
      // The caller adds a table/query reason. Keep the doctor report structured.
    }
  }

  const nextActions: string[] = [];
  if (!codexSessionDirExists) {
    nextActions.push("MEMORY_ROUTER_CODEX_SESSION_DIR を実在する Codex sessions root に設定する");
  }
  if (!antigravityConfigured) {
    nextActions.push("MEMORY_ROUTER_ANTIGRAVITY_LOG_DIR に Antigravity workspace root を設定する");
  } else if (!antigravityExists) {
    nextActions.push("MEMORY_ROUTER_ANTIGRAVITY_LOG_DIR のパスを確認する");
  }
  if (!states.some((state) => state.id === "codex_logs")) {
    nextActions.push("bun run sync:agent-logs を実行して Codex ログ同期を初期化する");
  }
  if (!launchAgent.installed) {
    nextActions.push("./scripts/setup-automation.sh install で LaunchAgent を配置する");
  } else if (!launchAgent.loaded) {
    nextActions.push("./scripts/setup-automation.sh load で LaunchAgent を読み込む");
  }

  return {
    codex: {
      sessionDir: config.codexSessionDir,
      sessionDirExists: codexSessionDirExists,
      archivedSessionDir: config.codexArchivedSessionDir,
      archivedSessionDirExists: codexArchivedSessionDirExists,
    },
    antigravity: {
      logDir: config.antigravityLogDir,
      configured: antigravityConfigured,
      exists: antigravityExists,
    },
    states,
    launchAgent,
    nextActions,
  };
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
  const embedding = await embeddingHealth();

  try {
    await db.execute(sql`select 1 as ok`);
  } catch (error) {
    const agentLogSync = await inspectAgentLogSync({
      canQueryDb: false,
      syncStatesTableAvailable: false,
    });
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
      embedding,
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
      agentLogSync,
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

  if (embedding.configured && !embedding.daemon.reachable && !embedding.cli.usable) {
    reasons.push("EMBEDDING_PROVIDER_UNAVAILABLE");
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

  const agentLogSync = await inspectAgentLogSync({
    canQueryDb: true,
    syncStatesTableAvailable: !missingTables.includes("sync_states"),
  });

  if (!agentLogSync.codex.sessionDirExists) {
    reasons.push("CODEX_SESSION_DIR_MISSING");
  }
  if (!agentLogSync.antigravity.configured) {
    reasons.push("ANTIGRAVITY_LOG_DIR_NOT_CONFIGURED");
  } else if (!agentLogSync.antigravity.exists) {
    reasons.push("ANTIGRAVITY_LOG_DIR_MISSING");
  }
  if (!agentLogSync.states.some((state) => state.id === "codex_logs")) {
    reasons.push("AGENT_LOG_SYNC_NEVER_RAN");
  }
  if (!agentLogSync.launchAgent.installed) {
    reasons.push("AGENT_LOG_SYNC_LAUNCH_AGENT_NOT_INSTALLED");
  } else if (!agentLogSync.launchAgent.loaded) {
    reasons.push("AGENT_LOG_SYNC_LAUNCH_AGENT_NOT_LOADED");
  }
  for (const state of agentLogSync.states) {
    if (
      state.lastSyncedAgeMinutes !== null &&
      state.lastSyncedAgeMinutes > options.freshnessThresholdMinutes
    ) {
      reasons.push(`${state.id.toUpperCase()}_SYNC_STALE`);
    }
    if (state.warnings.length > 0) {
      reasons.push(`${state.id.toUpperCase()}_SYNC_WARNINGS`);
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
    embedding,
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
    agentLogSync,
  });
}
