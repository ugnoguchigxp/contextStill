import { groupedConfig } from "../../config.js";
import { type DoctorReport, doctorReportSchema } from "../../shared/schemas/doctor.schema.js";
import { cleanupExpiredAuditLogsSafe } from "../audit/audit-log.service.js";
import { checkAgenticLlmHealth } from "../llm/agentic-llm.service.js";
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

function resolveDoctorOptions(rawOptions?: DoctorOptions): ResolvedDoctorOptions {
  return {
    windowSize: Math.max(1, rawOptions?.windowSize ?? 20),
    freshnessThresholdMinutes:
      rawOptions?.freshnessThresholdMinutes ?? groupedConfig.doctor.freshnessThresholdMinutes,
    degradedRateThreshold:
      rawOptions?.degradedRateThreshold ?? groupedConfig.doctor.degradedRateThreshold,
  };
}

function createEmptyRuns(options: ResolvedDoctorOptions): DoctorReport["runs"] {
  return {
    windowSize: options.windowSize,
    totalRuns: 0,
    degradedRuns: 0,
    degradedRate: 0,
    blockingRuns: 0,
    blockingRate: 0,
    usableRuns: 0,
    usableRate: 0,
    warningOnlyRuns: 0,
    warningOnlyRate: 0,
    noContentRuns: 0,
    noContentRate: 0,
    durationMsP50: null,
    durationMsP95: null,
    durationMsAvg: null,
    lastRunAt: null,
    lastRunAgeMinutes: null,
    freshnessThresholdMinutes: options.freshnessThresholdMinutes,
    degradedRateThreshold: options.degradedRateThreshold,
  };
}

function appendDistillationReasons(
  reasons: string[],
  options: ResolvedDoctorOptions,
  prefix: string,
  distillation: DoctorReport["vibeDistillation"],
): void {
  if (!distillation.launchAgent.installed) {
    reasons.push(`${prefix}_LAUNCH_AGENT_NOT_INSTALLED`);
  } else if (!distillation.launchAgent.loaded) {
    reasons.push(`${prefix}_LAUNCH_AGENT_NOT_LOADED`);
  }
  const ageMinutes = distillation.runs.lastOkRunAgeMinutes ?? distillation.runs.lastRunAgeMinutes;
  if (!distillation.runs.lastRunAt) {
    reasons.push(`${prefix}_NEVER_RAN`);
  } else if (typeof ageMinutes === "number" && ageMinutes > options.freshnessThresholdMinutes) {
    reasons.push(`${prefix}_STALE`);
  }
  if (distillation.queueHealth.staleRunning > 0) {
    reasons.push(`${prefix}_QUEUE_STALE_RUNNING`);
  }
  if (distillation.queueHealth.lock.staleByCreatedAge) {
    reasons.push(`${prefix}_PIPELINE_LOCK_STALE`);
  }
  const runnableQueued = distillation.queueHealth.queued + distillation.queueHealth.retryablePaused;
  if (
    runnableQueued > 0 &&
    distillation.queueHealth.running === 0 &&
    distillation.launchAgent.loaded &&
    !distillation.queueHealth.blockedByHigherPriority &&
    distillation.queueHealth.oldestQueuedAgeMinutes !== null &&
    distillation.queueHealth.oldestQueuedAgeMinutes >
      groupedConfig.distillation.pipelineLockStaleSeconds / 60
  ) {
    reasons.push(`${prefix}_QUEUE_STOPPED`);
  }
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

  appendDistillationReasons(reasons, options, "VIBE_DISTILLATION", vibeDistillation);
  appendDistillationReasons(reasons, options, "SOURCE_DISTILLATION", sourceDistillation);

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
  const agenticLlm = await checkAgenticLlmHealth(groupedConfig.agenticCompile.provider);
  const database = await inspectDatabase({
    freshnessThresholdMinutes: options.freshnessThresholdMinutes,
    staleDecayFactor: groupedConfig.doctor.knowledgeStaleDecayFactor,
    zeroUseWarningMinActiveCount: groupedConfig.doctor.knowledgeZeroUseWarningMinActiveCount,
  });

  if (!database.reachable) {
    const [agentLogSync, vibeDistillation, sourceDistillation] = await Promise.all([
      inspectAgentLogSync({
        canQueryDb: false,
        syncStatesTableAvailable: false,
      }),
      inspectVibeDistillation({
        canQueryDb: false,
      }),
      inspectSourceDistillation({
        canQueryDb: false,
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
      knowledgeLifecycle: database.knowledgeLifecycle,
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

  if (groupedConfig.agenticCompile.enabled && !agenticLlm.configured) {
    reasons.push("AGENTIC_LLM_NOT_CONFIGURED");
  } else if (groupedConfig.agenticCompile.enabled && !agenticLlm.reachable) {
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
    }),
    inspectSourceDistillation({
      canQueryDb: true,
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
      ...(database.knowledgeLifecycle.zeroUseActiveCount > 0
        ? [
            `unused active knowledge を確認する（${database.knowledgeLifecycle.zeroUseActiveCount}/${database.knowledgeLifecycle.activeCount}）`,
          ]
        : []),
      ...(database.knowledgeLifecycle.staleByDecayCount > 0
        ? [
            `decay が低い knowledge を再検証する（stale=${database.knowledgeLifecycle.staleByDecayCount}, threshold=${database.knowledgeLifecycle.thresholds.staleDecayFactor}）`,
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
    knowledgeLifecycle: database.knowledgeLifecycle,
    mcp: mcpReport,
    agentLogSync,
    vibeDistillation,
    sourceDistillation,
  });
}
