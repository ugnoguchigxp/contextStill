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
import type { DoctorReport } from "../../shared/schemas/doctor.schema.js";
import { isPipelineLockLikelyBlocking } from "./distillation-lock.util.js";
import type { ResolvedDoctorOptions } from "./doctor.types.js";

function createEmptyLaunchAgent(label: string): DoctorReport["agentLogSync"]["launchAgent"] {
  return {
    label,
    plistPath: "",
    installed: false,
    loaded: false,
    state: null,
  };
}

function createEmptyAgentLogSync(): DoctorReport["agentLogSync"] {
  return {
    codex: {
      sessionDir: "",
      sessionDirExists: false,
      archivedSessionDir: "",
      archivedSessionDirExists: false,
    },
    antigravity: {
      logDir: "",
      configured: false,
      exists: false,
    },
    states: [],
    launchAgent: createEmptyLaunchAgent("agent-log-sync"),
    nextActions: [],
  };
}

function createEmptyDistillationHealth(label: string): DoctorReport["vibeDistillation"] {
  return {
    launchAgent: createEmptyLaunchAgent(label),
    runs: {
      totalRuns: 0,
      okRuns: 0,
      skippedRuns: 0,
      outcomeKindCounts: [],
      skippedRunReasons: [],
      failedRuns: 0,
      lastRunAt: null,
      lastRunAgeMinutes: null,
      lastOkRunAt: null,
      lastOkRunAgeMinutes: null,
    },
    jobs: {
      queued: 0,
      running: 0,
      paused: 0,
      failed: 0,
      lastPausedAt: null,
      lastError: null,
    },
    queueHealth: {
      queued: 0,
      running: 0,
      retryablePaused: 0,
      staleRunning: 0,
      blockedByHigherPriority: false,
      oldestQueuedAt: null,
      oldestQueuedAgeMinutes: null,
      oldestRunningAt: null,
      oldestRunningAgeMinutes: null,
      lock: {
        path: "",
        exists: false,
        pid: null,
        createdAt: null,
        ageSeconds: null,
        staleByCreatedAge: false,
      },
    },
    nextActions: [],
  };
}

export function createEmptyRuns(options: ResolvedDoctorOptions): DoctorReport["runs"] {
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
    durationSamples: [],
    lastRunAt: null,
    lastRunAgeMinutes: null,
    freshnessThresholdMinutes: options.freshnessThresholdMinutes,
    degradedRateThreshold: options.degradedRateThreshold,
  };
}

export type ReasonResolutionContext = {
  options: ResolvedDoctorOptions;
  runs: DoctorReport["runs"];
  hitl: DoctorReport["hitl"];
  knowledgeLifecycle: DoctorReport["knowledgeLifecycle"];
  agentLogSync: DoctorReport["agentLogSync"];
  vibeDistillation: DoctorReport["vibeDistillation"];
  sourceDistillation: DoctorReport["sourceDistillation"];
};

export type ReasonResolutionResult = {
  reasons: string[];
  reasonDetails: DoctorReasonDetail[];
  skippedChecks: DoctorReasonDetail[];
  summary: DoctorReport["summary"];
  status: DoctorReport["status"];
};

export function createReasonResolutionContext(
  options: ResolvedDoctorOptions,
  overrides: Partial<Omit<ReasonResolutionContext, "options">>,
): ReasonResolutionContext {
  return {
    options,
    runs: overrides.runs ?? createEmptyRuns(options),
    hitl: overrides.hitl ?? {
      draftCount: 0,
      oldestDraftAt: null,
      oldestDraftAgeMinutes: null,
      backlogThresholdCount: groupedConfig.distillation.promotionBacklogThresholdCount,
      backlogThresholdAgeMinutes: 60 * 24 * 3,
    },
    knowledgeLifecycle: overrides.knowledgeLifecycle ?? {
      activeCount: 0,
      zeroUseActiveCount: 0,
      staleByDecayCount: 0,
      staleProcedureCount: 0,
      dynamicScoreAvg: null,
      dynamicScoreP95: null,
      lastCompiledAt: null,
      lastCompiledAgeMinutes: null,
      thresholds: {
        staleDecayFactor: groupedConfig.doctor.knowledgeStaleDecayFactor,
        zeroUseWarningMinActiveCount: groupedConfig.doctor.knowledgeZeroUseWarningMinActiveCount,
      },
    },
    agentLogSync: overrides.agentLogSync ?? createEmptyAgentLogSync(),
    vibeDistillation:
      overrides.vibeDistillation ?? createEmptyDistillationHealth("vibe-distillation"),
    sourceDistillation:
      overrides.sourceDistillation ?? createEmptyDistillationHealth("source-distillation"),
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
  } else if (
    prefix !== "SOURCE_DISTILLATION" &&
    typeof ageMinutes === "number" &&
    ageMinutes > options.freshnessThresholdMinutes
  ) {
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
    runnableQueued: distillation.queueHealth.queued + distillation.queueHealth.retryablePaused,
    blockedByHigherPriority: distillation.queueHealth.blockedByHigherPriority,
  });
  if (lockLikelyBlocking) {
    reasons.push(`${prefix}_PIPELINE_LOCK_STALE`);
  }
  const runnableQueued = distillation.queueHealth.queued + distillation.queueHealth.retryablePaused;
  const queueStoppedThresholdMinutes = groupedConfig.distillation.pipelineLockStaleSeconds / 60;
  const lastProgressAgeMinutes = distillation.runs.lastRunAgeMinutes;
  const noRecentProgress =
    lastProgressAgeMinutes === null || lastProgressAgeMinutes > queueStoppedThresholdMinutes;
  if (
    runnableQueued > 0 &&
    distillation.queueHealth.running === 0 &&
    distillation.launchAgent.loaded &&
    !distillation.queueHealth.blockedByHigherPriority &&
    distillation.queueHealth.oldestQueuedAgeMinutes !== null &&
    distillation.queueHealth.oldestQueuedAgeMinutes > queueStoppedThresholdMinutes &&
    noRecentProgress
  ) {
    reasons.push(`${prefix}_QUEUE_STOPPED`);
  }
}

export function appendAutomationReasons(
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
    const freshnessAgeMinutes = state.lastCheckedAgeMinutes ?? state.lastSyncedAgeMinutes;
    if (freshnessAgeMinutes !== null && freshnessAgeMinutes > options.freshnessThresholdMinutes) {
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

function distillationForReason(
  code: string,
  context: ReasonResolutionContext,
): DoctorReport["vibeDistillation"] | null {
  if (code.startsWith("VIBE_DISTILLATION_")) return context.vibeDistillation;
  if (code.startsWith("SOURCE_DISTILLATION_")) return context.sourceDistillation;
  return null;
}

function shouldTreatNeverRanAsMaintenance(code: string, context: ReasonResolutionContext): boolean {
  if (context.options.strict) return false;
  if (!code.endsWith("_NEVER_RAN")) return false;
  const distillation = distillationForReason(code, context);
  if (!distillation) return false;
  const queueTotal =
    distillation.jobs.queued +
    distillation.jobs.running +
    distillation.jobs.paused +
    distillation.jobs.failed;
  if (distillation.queueHealth.blockedByHigherPriority) return true;
  return queueTotal === 0 && distillation.runs.totalRuns === 0;
}

function resolveContextualImpactLevel(
  code: string,
  severity: DoctorReasonDetail["severity"],
  context: ReasonResolutionContext,
): Exclude<DoctorReasonImpactLevel, "skipped"> {
  if (shouldTreatNeverRanAsMaintenance(code, context)) return "maintenance";
  return resolveDoctorReasonImpactLevel(code, severity, context.options.strict);
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
          lastCheckedAgeMinutes: state.lastCheckedAgeMinutes ?? null,
          cursorFiles: state.cursorFiles,
          warnings: state.warnings.length,
        }
      : null;
  }
  return null;
}

export function resolveReasonDetails(
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
      : resolveContextualImpactLevel(code, defaultDetail.severity, context);
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
