import { config } from "../../config.js";
import { type DoctorReport, doctorReportSchema } from "../../shared/schemas/doctor.schema.js";
import { requiredTables } from "./doctor.constants.js";
import type { DoctorOptions, ResolvedDoctorOptions } from "./doctor.types.js";
import { nowIso } from "./doctor.utils.js";
import { inspectAgentLogSync } from "./inspectors/agent-log-sync.inspector.js";
import { inspectCompileRuns } from "./inspectors/compile.inspector.js";
import { inspectDatabase } from "./inspectors/database.inspector.js";
import { inspectEmbedding } from "./inspectors/embedding.inspector.js";
import { inspectMcpSurface } from "./inspectors/mcp.inspector.js";
import { inspectSourceDistillation } from "./inspectors/source-distillation.inspector.js";
import { inspectVibeDistillation } from "./inspectors/vibe-distillation.inspector.js";
import { cleanupExpiredAuditLogsSafe } from "../audit/audit-log.service.js";
import { checkAgenticLlmHealth } from "../llm/agentic-llm.service.js";

function resolveDoctorOptions(rawOptions?: DoctorOptions): ResolvedDoctorOptions {
  return {
    windowSize: Math.max(1, rawOptions?.windowSize ?? 20),
    freshnessThresholdMinutes:
      rawOptions?.freshnessThresholdMinutes ?? config.doctorFreshnessThresholdMinutes,
    degradedRateThreshold: rawOptions?.degradedRateThreshold ?? config.doctorDegradedRateThreshold,
  };
}

function createEmptyRuns(options: ResolvedDoctorOptions): DoctorReport["runs"] {
  return {
    windowSize: options.windowSize,
    totalRuns: 0,
    degradedRuns: 0,
    degradedRate: 0,
    durationMsP50: null,
    durationMsP95: null,
    durationMsAvg: null,
    lastRunAt: null,
    lastRunAgeMinutes: null,
    freshnessThresholdMinutes: options.freshnessThresholdMinutes,
    degradedRateThreshold: options.degradedRateThreshold,
  };
}

function appendAutomationReasons(
  reasons: string[],
  options: ResolvedDoctorOptions,
  agentLogSync: DoctorReport["agentLogSync"],
  vibeDistillation: DoctorReport["vibeDistillation"],
  sourceDistillation: DoctorReport["sourceDistillation"],
): void {
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
}

export async function runDoctor(rawOptions?: DoctorOptions): Promise<DoctorReport> {
  const options = resolveDoctorOptions(rawOptions);
  await cleanupExpiredAuditLogsSafe({ trigger: "doctor" });
  const reasons: string[] = [];
  const mcp = inspectMcpSurface();
  if (mcp.missingPrimaryTools.length > 0) {
    reasons.push("MCP_PRIMARY_TOOLS_MISSING");
  }

  const embedding = await inspectEmbedding();
  const agenticLlm = await checkAgenticLlmHealth(config.agenticCompileProvider);
  const database = await inspectDatabase({
    freshnessThresholdMinutes: options.freshnessThresholdMinutes,
  });

  if (!database.reachable) {
    const [agentLogSync, vibeDistillation, sourceDistillation] = await Promise.all([
      inspectAgentLogSync({
        canQueryDb: false,
        syncStatesTableAvailable: false,
      }),
      inspectVibeDistillation({
        canQueryDb: false,
        distillationTableAvailable: false,
      }),
      inspectSourceDistillation({
        canQueryDb: false,
        distillationTableAvailable: false,
      }),
    ]);

    return doctorReportSchema.parse({
      status: "failed",
      checkedAt: nowIso(),
      reasons: [...reasons, ...database.reasons],
      db: database.db,
      vector: { installed: database.vectorInstalled },
      embedding,
      agenticLlm,
      tables: {
        expected: [...requiredTables],
        existing: database.existingTables,
        missing: database.missingTables,
      },
      runs: createEmptyRuns(options),
      hitl: database.hitl,
      mcp,
      agentLogSync,
      vibeDistillation,
      sourceDistillation,
    });
  }

  reasons.push(...database.reasons);

  if (embedding.configured && !embedding.daemon.reachable && !embedding.cli.usable) {
    reasons.push("EMBEDDING_PROVIDER_UNAVAILABLE");
  }

  if (config.agenticCompileEnabled && !agenticLlm.configured) {
    reasons.push("AGENTIC_LLM_NOT_CONFIGURED");
  } else if (config.agenticCompileEnabled && !agenticLlm.reachable) {
    reasons.push("AGENTIC_LLM_UNREACHABLE");
  }

  const compile = await inspectCompileRuns({
    windowSize: options.windowSize,
    freshnessThresholdMinutes: options.freshnessThresholdMinutes,
    degradedRateThreshold: options.degradedRateThreshold,
    compileRunsTableAvailable: !database.missingTables.includes("context_compile_runs"),
  });
  reasons.push(...compile.reasons);

  const [agentLogSync, vibeDistillation, sourceDistillation] = await Promise.all([
    inspectAgentLogSync({
      canQueryDb: true,
      syncStatesTableAvailable: !database.missingTables.includes("sync_states"),
    }),
    inspectVibeDistillation({
      canQueryDb: true,
      distillationTableAvailable: !database.missingTables.includes("vibe_memory_distillation_runs"),
    }),
    inspectSourceDistillation({
      canQueryDb: true,
      distillationTableAvailable: !database.missingTables.includes("source_distillation_runs"),
    }),
  ]);

  appendAutomationReasons(reasons, options, agentLogSync, vibeDistillation, sourceDistillation);

  const status =
    reasons.includes("MISSING_REQUIRED_TABLES") || reasons.includes("REQUIRED_TABLES_CHECK_FAILED")
      ? "failed"
      : reasons.length > 0
        ? "degraded"
        : "ok";

  const mcpReport: DoctorReport["mcp"] = {
    ...mcp,
    staleKnowledgeCount: database.staleKnowledgeCount,
    staleSourceCount: database.staleSourceCount,
    nextActions: [
      ...mcp.nextActions,
      ...(database.staleKnowledgeCount > 0
        ? [`deprecated knowledge を整理する（count: ${database.staleKnowledgeCount}）`]
        : []),
      ...(database.staleSourceCount > 0
        ? [`stale source を再importまたは更新する（count: ${database.staleSourceCount}）`]
        : []),
      ...(database.hitl.draftCount > database.hitl.backlogThresholdCount
        ? [
            `draft backlog が閾値超過（${database.hitl.draftCount}/${database.hitl.backlogThresholdCount}）。Knowledge UI で一括レビューする`,
          ]
        : []),
    ],
  };

  return doctorReportSchema.parse({
    status,
    checkedAt: nowIso(),
    reasons,
    db: database.db,
    vector: {
      installed: database.vectorInstalled,
    },
    embedding,
    agenticLlm,
    tables: {
      expected: [...requiredTables],
      existing: database.existingTables,
      missing: database.missingTables,
    },
    runs: compile.runs,
    hitl: database.hitl,
    mcp: mcpReport,
    agentLogSync,
    vibeDistillation,
    sourceDistillation,
  });
}
