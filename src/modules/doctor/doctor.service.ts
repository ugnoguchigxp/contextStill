import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import { config } from "../../config.js";
import { getDb } from "../../db/index.js";
import { syncStates } from "../../db/schema.js";
import { getExposedToolEntries } from "../../mcp/tools/index.js";
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
  "vibe_memory_distillation_runs",
  "source_distillation_runs",
  "source_distillation_evidence",
  "relations",
  "context_compile_runs",
  "context_pack_items",
  "sync_states",
] as const;

const requiredTableSqlList = requiredTables.map((tableName) => `'${tableName}'`).join(", ");

const requiredPrimaryMcpTools = [
  "initial_instructions",
  "context_compile",
  "search_knowledge",
  "register_knowledge",
  "memory_search",
  "memory_fetch",
  "doctor",
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

function inspectMcpSurface(): DoctorReport["mcp"] {
  const exposedTools = getExposedToolEntries()
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  const missingPrimaryTools = requiredPrimaryMcpTools.filter(
    (name) => !exposedTools.includes(name),
  );
  const nextActions: string[] = [];
  if (missingPrimaryTools.length > 0) {
    nextActions.push(`不足 MCP primary tools を追加する: ${missingPrimaryTools.join(", ")}`);
  }
  return {
    exposedTools,
    requiredPrimaryTools: [...requiredPrimaryMcpTools],
    missingPrimaryTools,
    staleKnowledgeCount: 0,
    staleSourceCount: 0,
    nextActions,
  };
}

async function inspectLaunchAgent(
  label: string,
): Promise<DoctorReport["agentLogSync"]["launchAgent"]> {
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
  const launchAgent = await inspectLaunchAgent("com.memory-router.agent-log-sync");
  const states: DoctorReport["agentLogSync"]["states"] = [];

  if (params.canQueryDb && params.syncStatesTableAvailable) {
    try {
      const rows = await getDb()
        .select()
        .from(syncStates)
        .where(inArray(syncStates.id, ["codex_logs", "antigravity_logs"]));
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

async function inspectVibeDistillation(params: {
  canQueryDb: boolean;
  distillationTableAvailable: boolean;
}): Promise<DoctorReport["vibeDistillation"]> {
  const launchAgent = await inspectLaunchAgent("com.memory-router.vibe-distillation");
  const runs: DoctorReport["vibeDistillation"]["runs"] = {
    totalRuns: 0,
    okRuns: 0,
    skippedRuns: 0,
    failedRuns: 0,
    lastRunAt: null,
    lastRunAgeMinutes: null,
  };

  if (params.canQueryDb && params.distillationTableAvailable) {
    try {
      const db = getDb();
      const [state] = await db
        .select()
        .from(syncStates)
        .where(eq(syncStates.id, "vibe_distillation"))
        .limit(1);
      const result = await db.execute(sql`
        with latest as (
          select distinct on (vibe_memory_id)
            status,
            updated_at
          from vibe_memory_distillation_runs
          where prompt_version = ${config.vibeDistillationPromptVersion}
          order by vibe_memory_id, updated_at desc, id desc
        )
        select
          count(*)::int as total_runs,
          count(*) filter (where status = 'ok')::int as ok_runs,
          count(*) filter (where status = 'skipped')::int as skipped_runs,
          count(*) filter (where status = 'failed')::int as failed_runs,
          max(updated_at) as last_run_at
        from latest
      `);
      const row = result.rows[0] as
        | {
            total_runs?: number;
            ok_runs?: number;
            skipped_runs?: number;
            failed_runs?: number;
            last_run_at?: Date | string | null;
          }
        | undefined;
      const lastRunAt =
        row?.last_run_at instanceof Date
          ? row.last_run_at.toISOString()
          : row?.last_run_at
            ? new Date(row.last_run_at).toISOString()
            : null;
      runs.totalRuns = Number(row?.total_runs ?? 0);
      runs.okRuns = Number(row?.ok_runs ?? 0);
      runs.skippedRuns = Number(row?.skipped_runs ?? 0);
      runs.failedRuns = Number(row?.failed_runs ?? 0);
      runs.lastRunAt = state?.lastSyncedAt?.toISOString() ?? lastRunAt;
      runs.lastRunAgeMinutes = runs.lastRunAt ? minutesSince(runs.lastRunAt) : null;
    } catch {
      // Keep doctor resilient. The caller records table-level problems separately.
    }
  }

  const nextActions: string[] = [];
  if (!launchAgent.installed) {
    nextActions.push(
      "./scripts/setup-distillation-automation.sh install で LaunchAgent を配置する",
    );
  } else if (!launchAgent.loaded) {
    nextActions.push("./scripts/setup-distillation-automation.sh load で LaunchAgent を読み込む");
  }
  if (!runs.lastRunAt) {
    nextActions.push("bun run distill:vibe-memory -- --apply を一度実行して処理経路を確認する");
  }

  return { launchAgent, runs, nextActions };
}

async function inspectSourceDistillation(params: {
  canQueryDb: boolean;
  distillationTableAvailable: boolean;
}): Promise<DoctorReport["sourceDistillation"]> {
  const launchAgent = await inspectLaunchAgent("com.memory-router.source-distillation");
  const runs: DoctorReport["sourceDistillation"]["runs"] = {
    totalRuns: 0,
    okRuns: 0,
    skippedRuns: 0,
    failedRuns: 0,
    lastRunAt: null,
    lastRunAgeMinutes: null,
  };

  if (params.canQueryDb && params.distillationTableAvailable) {
    try {
      const db = getDb();
      const [state] = await db
        .select()
        .from(syncStates)
        .where(eq(syncStates.id, "source_distillation"))
        .limit(1);
      const result = await db.execute(sql`
        with latest as (
          select distinct on (source_fragment_id)
            status,
            updated_at
          from source_distillation_runs
          where prompt_version = ${config.sourceDistillationPromptVersion}
          order by source_fragment_id, updated_at desc, id desc
        )
        select
          count(*)::int as total_runs,
          count(*) filter (where status = 'ok')::int as ok_runs,
          count(*) filter (where status = 'skipped')::int as skipped_runs,
          count(*) filter (where status = 'failed')::int as failed_runs,
          max(updated_at) as last_run_at
        from latest
      `);
      const row = result.rows[0] as
        | {
            total_runs?: number;
            ok_runs?: number;
            skipped_runs?: number;
            failed_runs?: number;
            last_run_at?: Date | string | null;
          }
        | undefined;
      const lastRunAt =
        row?.last_run_at instanceof Date
          ? row.last_run_at.toISOString()
          : row?.last_run_at
            ? new Date(row.last_run_at).toISOString()
            : null;
      runs.totalRuns = Number(row?.total_runs ?? 0);
      runs.okRuns = Number(row?.ok_runs ?? 0);
      runs.skippedRuns = Number(row?.skipped_runs ?? 0);
      runs.failedRuns = Number(row?.failed_runs ?? 0);
      runs.lastRunAt = state?.lastSyncedAt?.toISOString() ?? lastRunAt;
      runs.lastRunAgeMinutes = runs.lastRunAt ? minutesSince(runs.lastRunAt) : null;
    } catch {
      // Keep doctor resilient. The caller records table-level problems separately.
    }
  }

  const nextActions: string[] = [];
  if (!launchAgent.installed) {
    nextActions.push(
      "./scripts/setup-source-distillation-automation.sh install で LaunchAgent を配置する",
    );
  } else if (!launchAgent.loaded) {
    nextActions.push(
      "./scripts/setup-source-distillation-automation.sh load で LaunchAgent を読み込む",
    );
  }
  if (!runs.lastRunAt) {
    nextActions.push("bun run distill:sources -- --apply を一度実行して処理経路を確認する");
  }

  return { launchAgent, runs, nextActions };
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
  const mcp = inspectMcpSurface();
  if (mcp.missingPrimaryTools.length > 0) {
    reasons.push("MCP_PRIMARY_TOOLS_MISSING");
  }
  const startedAt = Date.now();
  const embedding = await embeddingHealth();

  try {
    await db.execute(sql`select 1 as ok`);
  } catch (error) {
    const agentLogSync = await inspectAgentLogSync({
      canQueryDb: false,
      syncStatesTableAvailable: false,
    });
    const vibeDistillation = await inspectVibeDistillation({
      canQueryDb: false,
      distillationTableAvailable: false,
    });
    const sourceDistillation = await inspectSourceDistillation({
      canQueryDb: false,
      distillationTableAvailable: false,
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
      mcp,
      agentLogSync,
      vibeDistillation,
      sourceDistillation,
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

  let staleKnowledgeCount = 0;
  let staleSourceCount = 0;
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
  }
  if (!missingTables.includes("sources")) {
    try {
      const result = await db.execute(sql`
        select count(*)::int as count
        from sources
        where updated_at < now() - (${options.freshnessThresholdMinutes} * interval '1 minute')
      `);
      staleSourceCount = Number((result.rows as Array<{ count?: number }>)[0]?.count ?? 0);
    } catch {
      reasons.push("STALE_SOURCE_COUNT_QUERY_FAILED");
    }
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
  const vibeDistillation = await inspectVibeDistillation({
    canQueryDb: true,
    distillationTableAvailable: !missingTables.includes("vibe_memory_distillation_runs"),
  });
  const sourceDistillation = await inspectSourceDistillation({
    canQueryDb: true,
    distillationTableAvailable: !missingTables.includes("source_distillation_runs"),
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
  if (!vibeDistillation.launchAgent.installed) {
    reasons.push("VIBE_DISTILLATION_LAUNCH_AGENT_NOT_INSTALLED");
  } else if (!vibeDistillation.launchAgent.loaded) {
    reasons.push("VIBE_DISTILLATION_LAUNCH_AGENT_NOT_LOADED");
  }
  if (!vibeDistillation.runs.lastRunAt) {
    reasons.push("VIBE_DISTILLATION_NEVER_RAN");
  } else if (
    vibeDistillation.runs.lastRunAgeMinutes !== null &&
    vibeDistillation.runs.lastRunAgeMinutes > options.freshnessThresholdMinutes
  ) {
    reasons.push("VIBE_DISTILLATION_STALE");
  }
  if (!sourceDistillation.launchAgent.installed) {
    reasons.push("SOURCE_DISTILLATION_LAUNCH_AGENT_NOT_INSTALLED");
  } else if (!sourceDistillation.launchAgent.loaded) {
    reasons.push("SOURCE_DISTILLATION_LAUNCH_AGENT_NOT_LOADED");
  }
  if (!sourceDistillation.runs.lastRunAt) {
    reasons.push("SOURCE_DISTILLATION_NEVER_RAN");
  } else if (
    sourceDistillation.runs.lastRunAgeMinutes !== null &&
    sourceDistillation.runs.lastRunAgeMinutes > options.freshnessThresholdMinutes
  ) {
    reasons.push("SOURCE_DISTILLATION_STALE");
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

  const mcpReport: DoctorReport["mcp"] = {
    ...mcp,
    staleKnowledgeCount,
    staleSourceCount,
    nextActions: [
      ...mcp.nextActions,
      ...(staleKnowledgeCount > 0
        ? [`deprecated knowledge を整理する（count: ${staleKnowledgeCount}）`]
        : []),
      ...(staleSourceCount > 0
        ? [`stale source を再importまたは更新する（count: ${staleSourceCount}）`]
        : []),
    ],
  };

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
    mcp: mcpReport,
    agentLogSync,
    vibeDistillation,
    sourceDistillation,
  });
}
