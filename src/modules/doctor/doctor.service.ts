import { groupedConfig } from "../../config.js";
import {
  type DoctorReasonDetail,
  type DoctorReasonEnvironmentScope,
  type DoctorReasonImpactLevel,
  formatDoctorReasonDetail,
  resolveDoctorReasonCommands,
  resolveDoctorReasonEnvironmentScope,
  resolveDoctorReasonImpactLevel,
} from "../../shared/doctor/doctor-reasons.js";
import { type DoctorReport, doctorReportSchema } from "../../shared/schemas/doctor.schema.js";
import { cleanupExpiredAuditLogsSafe } from "../audit/audit-log.service.js";
import { checkAgenticLlmHealth } from "../llm/agentic-llm.service.js";
import { isPipelineLockLikelyBlocking } from "./distillation-lock.util.js";
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
    strict: rawOptions?.strict ?? false,
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
  const lockLikelyBlocking = isPipelineLockLikelyBlocking({
    staleByCreatedAge: distillation.queueHealth.lock.staleByCreatedAge,
    launchAgentLoaded: distillation.launchAgent.loaded,
    staleRunning: distillation.queueHealth.staleRunning,
    running: distillation.queueHealth.running,
    blockedByHigherPriority: distillation.queueHealth.blockedByHigherPriority,
  });
  if (lockLikelyBlocking) {
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

const failedReasonCodes = new Set([
  "DB_UNREACHABLE",
  "MISSING_REQUIRED_TABLES",
  "REQUIRED_TABLES_CHECK_FAILED",
]);

type ReasonResolutionContext = {
  options: ResolvedDoctorOptions;
  runs: DoctorReport["runs"];
  hitl: DoctorReport["hitl"];
  knowledgeLifecycle: DoctorReport["knowledgeLifecycle"];
  agentLogSync: DoctorReport["agentLogSync"];
  vibeDistillation: DoctorReport["vibeDistillation"];
  sourceDistillation: DoctorReport["sourceDistillation"];
};

type ReasonResolutionResult = {
  reasons: string[];
  reasonDetails: DoctorReasonDetail[];
  skippedChecks: DoctorReasonDetail[];
  summary: DoctorReport["summary"];
  status: DoctorReport["status"];
};

function distillationConfigured(distillation: DoctorReport["vibeDistillation"]): boolean {
  const queueTotal =
    distillation.jobs.queued +
    distillation.jobs.running +
    distillation.jobs.paused +
    distillation.jobs.failed;
  return (
    queueTotal > 0 ||
    distillation.runs.totalRuns > 0 ||
    distillation.launchAgent.installed ||
    distillation.launchAgent.loaded
  );
}

function syncStateConfigured(
  states: DoctorReport["agentLogSync"]["states"],
  stateId: string,
): boolean {
  const state = states.find((item) => item.id === stateId);
  if (!state) return false;
  return state.cursorFiles > 0 || state.lastSyncedAt !== null;
}

function shouldActivateConfiguredReason(code: string, context: ReasonResolutionContext): boolean {
  if (context.options.strict) return true;
  if (code === "AGENT_LOG_SYNC_NEVER_RAN") {
    return (
      context.agentLogSync.launchAgent.installed ||
      context.agentLogSync.launchAgent.loaded ||
      context.agentLogSync.states.length > 0
    );
  }
  if (code.startsWith("CODEX_LOGS_SYNC_")) {
    return (
      syncStateConfigured(context.agentLogSync.states, "codex_logs") ||
      context.agentLogSync.launchAgent.installed ||
      context.agentLogSync.launchAgent.loaded
    );
  }
  if (code.startsWith("ANTIGRAVITY_LOGS_SYNC_")) {
    return (
      syncStateConfigured(context.agentLogSync.states, "antigravity_logs") ||
      context.agentLogSync.launchAgent.installed ||
      context.agentLogSync.launchAgent.loaded
    );
  }
  if (code.startsWith("VIBE_DISTILLATION_")) {
    return distillationConfigured(context.vibeDistillation);
  }
  if (code.startsWith("SOURCE_DISTILLATION_")) {
    return distillationConfigured(context.sourceDistillation);
  }
  return false;
}

function shouldSkipReason(
  code: string,
  scope: DoctorReasonEnvironmentScope,
  context: ReasonResolutionContext,
): boolean {
  if (!groupedConfig.agenticCompile.enabled && code.startsWith("AGENTIC_LLM_")) {
    return true;
  }
  if (scope === "strict_only") {
    return !context.options.strict;
  }
  if (scope === "configured_only") {
    return !shouldActivateConfiguredReason(code, context);
  }
  if (scope === "non_empty_db") {
    if (code === "DEGRADED_RATE_HIGH" || code === "USABLE_PACK_RATE_LOW") {
      return context.runs.totalRuns < 1;
    }
    if (code === "KNOWLEDGE_ZERO_USE_HIGH") {
      return (
        context.knowledgeLifecycle.activeCount <
        context.knowledgeLifecycle.thresholds.zeroUseWarningMinActiveCount
      );
    }
    if (code === "HITL_DRAFT_BACKLOG_HIGH" || code === "HITL_DRAFT_REVIEW_STALE") {
      return context.hitl.draftCount < 1;
    }
  }
  return false;
}

function evidenceForReason(
  code: string,
  context: ReasonResolutionContext,
): Record<string, unknown> | null {
  if (code === "DEGRADED_RATE_HIGH") {
    return {
      totalRuns: context.runs.totalRuns,
      blockingRate: context.runs.blockingRate ?? 0,
      threshold: context.options.degradedRateThreshold,
    };
  }
  if (code === "USABLE_PACK_RATE_LOW") {
    return {
      totalRuns: context.runs.totalRuns,
      usableRate: context.runs.usableRate ?? 0,
      threshold: 1 - context.options.degradedRateThreshold,
    };
  }
  if (code === "KNOWLEDGE_ZERO_USE_HIGH") {
    return {
      activeCount: context.knowledgeLifecycle.activeCount,
      zeroUseActiveCount: context.knowledgeLifecycle.zeroUseActiveCount,
    };
  }
  if (code === "HITL_DRAFT_BACKLOG_HIGH" || code === "HITL_DRAFT_REVIEW_STALE") {
    return {
      draftCount: context.hitl.draftCount,
      oldestDraftAgeMinutes: context.hitl.oldestDraftAgeMinutes,
      thresholdCount: context.hitl.backlogThresholdCount,
      thresholdAgeMinutes: context.hitl.backlogThresholdAgeMinutes,
    };
  }
  if (code.startsWith("VIBE_DISTILLATION_")) {
    return {
      queued: context.vibeDistillation.queueHealth.queued,
      running: context.vibeDistillation.queueHealth.running,
      retryablePaused: context.vibeDistillation.queueHealth.retryablePaused,
      staleRunning: context.vibeDistillation.queueHealth.staleRunning,
      blockedByHigherPriority: context.vibeDistillation.queueHealth.blockedByHigherPriority,
      lock: context.vibeDistillation.queueHealth.lock,
    };
  }
  if (code.startsWith("SOURCE_DISTILLATION_")) {
    return {
      queued: context.sourceDistillation.queueHealth.queued,
      running: context.sourceDistillation.queueHealth.running,
      retryablePaused: context.sourceDistillation.queueHealth.retryablePaused,
      staleRunning: context.sourceDistillation.queueHealth.staleRunning,
      blockedByHigherPriority: context.sourceDistillation.queueHealth.blockedByHigherPriority,
      lock: context.sourceDistillation.queueHealth.lock,
    };
  }
  if (code.startsWith("CODEX_LOGS_SYNC_") || code.startsWith("ANTIGRAVITY_LOGS_SYNC_")) {
    const stateId = code.startsWith("CODEX_") ? "codex_logs" : "antigravity_logs";
    const state = context.agentLogSync.states.find((item) => item.id === stateId);
    return state
      ? {
          stateId,
          lastSyncedAgeMinutes: state.lastSyncedAgeMinutes,
          cursorFiles: state.cursorFiles,
          warnings: state.warnings.length,
        }
      : null;
  }
  return null;
}

function resolveReasonDetails(
  rawReasons: string[],
  context: ReasonResolutionContext,
): ReasonResolutionResult {
  const uniqueReasons = [...new Set(rawReasons)];
  const reasons: string[] = [];
  const reasonDetails: DoctorReasonDetail[] = [];
  const skippedChecks: DoctorReasonDetail[] = [];
  const summary: DoctorReport["summary"] = {
    blocking: 0,
    degraded: 0,
    maintenance: 0,
    skipped: 0,
  };

  for (const code of uniqueReasons) {
    const defaultDetail = formatDoctorReasonDetail(code, { strict: context.options.strict });
    const scope = resolveDoctorReasonEnvironmentScope(code);
    const shouldSkip = shouldSkipReason(code, scope, context);
    const impactLevel: DoctorReasonImpactLevel = shouldSkip
      ? "skipped"
      : resolveDoctorReasonImpactLevel(code, defaultDetail.severity, context.options.strict);
    const detail = formatDoctorReasonDetail(code, {
      strict: context.options.strict,
      impactLevel,
      environmentScope: scope,
      commands: resolveDoctorReasonCommands(code),
      evidence: evidenceForReason(code, context),
    });

    summary[impactLevel] += 1;
    if (impactLevel === "skipped") {
      skippedChecks.push(detail);
      continue;
    }
    reasons.push(code);
    reasonDetails.push(detail);
  }

  const status: DoctorReport["status"] = reasons.some((code) => failedReasonCodes.has(code))
    ? "failed"
    : summary.blocking > 0 || summary.degraded > 0
      ? "degraded"
      : "ok";

  return {
    reasons,
    reasonDetails,
    skippedChecks,
    summary,
    status,
  };
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

    const mergedReasons = [...reasons, ...database.reasons];
    const emptyRuns = createEmptyRuns(options);
    const reasonResolution = resolveReasonDetails(mergedReasons, {
      options,
      runs: emptyRuns,
      hitl: database.hitl,
      knowledgeLifecycle: database.knowledgeLifecycle,
      agentLogSync,
      vibeDistillation,
      sourceDistillation,
    });
    return doctorReportSchema.parse({
      status: reasonResolution.status,
      checkedAt: nowIso(),
      summary: reasonResolution.summary,
      reasons: reasonResolution.reasons,
      reasonDetails: reasonResolution.reasonDetails,
      skippedChecks: reasonResolution.skippedChecks,
      db: database.db,
      vector: { installed: database.vectorInstalled },
      embedding,
      agenticLlm,
      tables: {
        expected: [...requiredTables],
        existing: database.existingTables,
        missing: database.missingTables,
      },
      runs: emptyRuns,
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
  const reasonResolution = resolveReasonDetails(reasons, {
    options,
    runs: compile.runs,
    hitl: database.hitl,
    knowledgeLifecycle: database.knowledgeLifecycle,
    agentLogSync,
    vibeDistillation,
    sourceDistillation,
  });

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
    status: reasonResolution.status,
    checkedAt: nowIso(),
    summary: reasonResolution.summary,
    reasons: reasonResolution.reasons,
    reasonDetails: reasonResolution.reasonDetails,
    skippedChecks: reasonResolution.skippedChecks,
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
