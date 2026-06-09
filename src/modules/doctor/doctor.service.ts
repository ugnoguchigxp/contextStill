import { groupedConfig } from "../../config.js";
import {
  type DoctorAiServiceToolsDomain,
  type DoctorCoreInfrastructureDomain,
  type DoctorDomainName,
  type DoctorDomainReport,
  type DoctorPipelineAutomationDomain,
  type DoctorReport,
  doctorAiServiceToolsDomainSchema,
  doctorCoreInfrastructureDomainSchema,
  doctorPipelineAutomationDomainSchema,
  doctorReportSchema,
} from "../../shared/schemas/doctor.schema.js";
import { cleanupExpiredAuditLogsSafe } from "../audit/audit-log.service.js";
import {
  type AgenticLlmHealthStatus,
  checkAgenticLlmHealth,
  checkLlmProviderHealthMatrix,
} from "../llm/agentic-llm.service.js";
import {
  ensureRuntimeSettingsLoaded,
  resolveAgenticCompileRouting,
} from "../settings/settings.service.js";
import {
  appendAutomationReasons,
  createEmptyRuns,
  createReasonResolutionContext,
  resolveReasonDetails,
} from "./doctor-reason-resolution.js";
import { requiredTables } from "./doctor.constants.js";
import type { DoctorOptions, ResolvedDoctorOptions } from "./doctor.types.js";
import { nowIso } from "./doctor.utils.js";
import { inspectAgentLogSync } from "./inspectors/agent-log-sync.inspector.js";
import { inspectCompileRuns } from "./inspectors/compile.inspector.js";
import { inspectContextDecision } from "./inspectors/context-decision.inspector.js";
import { type DatabaseInspection, inspectDatabase } from "./inspectors/database.inspector.js";
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

async function inspectDoctorDatabase(options: ResolvedDoctorOptions): Promise<DatabaseInspection> {
  return inspectDatabase({
    freshnessThresholdMinutes: options.freshnessThresholdMinutes,
    staleDecayFactor: groupedConfig.doctor.knowledgeStaleDecayFactor,
    zeroUseWarningMinActiveCount: groupedConfig.doctor.knowledgeZeroUseWarningMinActiveCount,
  });
}

async function inspectAgenticLlmWithProviderHealth(
  timeoutMs = 5000,
): Promise<AgenticLlmHealthStatus> {
  const agenticRouting = resolveAgenticCompileRouting();
  const agenticLlm = await checkAgenticLlmHealth(
    agenticRouting.provider,
    timeoutMs,
    agenticRouting.fallback,
    agenticRouting.azureDeploymentSlots,
  );
  const providerHealth = await checkLlmProviderHealthMatrix(timeoutMs, {
    selectedProvider: agenticLlm.selectedProvider,
    routeOrder: agenticLlm.fallbackOrder,
    selectedAzureDeploymentSlots: agenticRouting.azureDeploymentSlots,
    selectedLocalLlmModel: agenticLlm.provider === "local-llm" ? agenticLlm.model : undefined,
  });
  return {
    ...agenticLlm,
    providerHealth,
  };
}

function buildMcpReport(
  mcp: DoctorReport["mcp"],
  database: DatabaseInspection,
): DoctorReport["mcp"] {
  return {
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
}

function createUnavailableContextDecisionReport(): DoctorReport["contextDecision"] {
  return {
    available: false,
    totalDecisions: 0,
    decisionCounts: {},
    escalateRate: 0,
    escalateTargetRate: 0.1,
    goodFeedbackCount: 0,
    badFeedbackCount: 0,
    prDiscardFeedbackCount: 0,
    autoAppliedEffectsCount: 0,
    queuedEffectsCount: 0,
    degradedDecisionsCount: 0,
    requiredZeroEvidenceCount: 0,
    ghAvailable: false,
    nextActions: ["Restore database connectivity before inspecting context_decision."],
  };
}

export async function runDoctor(rawOptions?: DoctorOptions): Promise<DoctorReport> {
  await ensureRuntimeSettingsLoaded();
  const options = resolveDoctorOptions(rawOptions);
  await cleanupExpiredAuditLogsSafe({ trigger: "doctor" });
  const reasons: string[] = [];
  const mcp = await inspectMcpSurface();
  if (mcp.missingPrimaryTools.length > 0) {
    reasons.push("MCP_PRIMARY_TOOLS_MISSING");
  }

  const embedding = await inspectEmbedding();
  const agenticLlm = await inspectAgenticLlmWithProviderHealth(5000);
  const database = await inspectDoctorDatabase(options);

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
      contextDecision: createUnavailableContextDecisionReport(),
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
  const contextDecision = await inspectContextDecision({
    tableAvailable: !database.missingTables.includes("context_decision_runs"),
  });
  reasons.push(...contextDecision.reasons);

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

  const mcpReport = buildMcpReport(mcp, database);

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
    contextDecision: contextDecision.report,
    agentLogSync,
    vibeDistillation,
    sourceDistillation,
  });
}

async function prepareDoctorDomainOptions(
  rawOptions?: DoctorOptions,
): Promise<ResolvedDoctorOptions> {
  await ensureRuntimeSettingsLoaded();
  return resolveDoctorOptions(rawOptions);
}

export async function runDoctorCoreInfrastructure(
  rawOptions?: DoctorOptions,
): Promise<DoctorCoreInfrastructureDomain> {
  const options = await prepareDoctorDomainOptions(rawOptions);
  const [embedding, database] = await Promise.all([
    inspectEmbedding(),
    inspectDoctorDatabase(options),
  ]);

  const reasons = [...database.reasons];
  if (embedding.configured && !embedding.daemon.reachable && !embedding.cli.usable) {
    reasons.push("EMBEDDING_PROVIDER_UNAVAILABLE");
  }

  const reasonResolution = resolveReasonDetails(
    reasons,
    createReasonResolutionContext(options, {
      hitl: database.hitl,
      knowledgeLifecycle: database.knowledgeLifecycle,
    }),
  );

  return doctorCoreInfrastructureDomainSchema.parse({
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
    tables: {
      expected: [...requiredTables],
      existing: database.existingTables,
      missing: database.missingTables,
    },
    hitl: database.hitl,
    knowledgeLifecycle: database.knowledgeLifecycle,
  });
}

export async function runDoctorAiServiceTools(
  rawOptions?: DoctorOptions,
): Promise<DoctorAiServiceToolsDomain> {
  const options = await prepareDoctorDomainOptions(rawOptions);
  const mcp = await inspectMcpSurface();
  const agenticLlm = await inspectAgenticLlmWithProviderHealth(5000);

  const reasons: string[] = [];
  if (mcp.missingPrimaryTools.length > 0) {
    reasons.push("MCP_PRIMARY_TOOLS_MISSING");
  }
  if (groupedConfig.agenticCompile.enabled && !agenticLlm.configured) {
    reasons.push("AGENTIC_LLM_NOT_CONFIGURED");
  } else if (groupedConfig.agenticCompile.enabled && !agenticLlm.reachable) {
    reasons.push("AGENTIC_LLM_UNREACHABLE");
  }

  const reasonResolution = resolveReasonDetails(
    reasons,
    createReasonResolutionContext(options, {}),
  );

  return doctorAiServiceToolsDomainSchema.parse({
    status: reasonResolution.status,
    checkedAt: nowIso(),
    summary: reasonResolution.summary,
    reasons: reasonResolution.reasons,
    reasonDetails: reasonResolution.reasonDetails,
    skippedChecks: reasonResolution.skippedChecks,
    agenticLlm,
    mcp,
  });
}

export async function runDoctorPipelineAutomation(
  rawOptions?: DoctorOptions,
): Promise<DoctorPipelineAutomationDomain> {
  const options = await prepareDoctorDomainOptions(rawOptions);
  const database = await inspectDoctorDatabase(options);
  const reasons: string[] = [];
  let runs: DoctorReport["runs"] = createEmptyRuns(options);
  let agentLogSync: DoctorReport["agentLogSync"];
  let vibeDistillation: DoctorReport["vibeDistillation"];
  let sourceDistillation: DoctorReport["sourceDistillation"];

  if (!database.reachable) {
    reasons.push(...database.reasons);
    [agentLogSync, vibeDistillation, sourceDistillation] = await Promise.all([
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
  } else {
    const [compile, inspectedAgentLogSync, inspectedVibeDistillation, inspectedSourceDistillation] =
      await Promise.all([
        inspectCompileRuns({
          windowSize: options.windowSize,
          freshnessThresholdMinutes: options.freshnessThresholdMinutes,
          degradedRateThreshold: options.degradedRateThreshold,
          compileRunsTableAvailable: !database.missingTables.includes("context_compile_runs"),
        }),
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
    runs = compile.runs;
    agentLogSync = inspectedAgentLogSync;
    vibeDistillation = inspectedVibeDistillation;
    sourceDistillation = inspectedSourceDistillation;
    reasons.push(...compile.reasons);
    appendAutomationReasons(reasons, options, agentLogSync, vibeDistillation, sourceDistillation);
  }

  const reasonResolution = resolveReasonDetails(
    reasons,
    createReasonResolutionContext(options, {
      runs,
      hitl: database.hitl,
      knowledgeLifecycle: database.knowledgeLifecycle,
      agentLogSync,
      vibeDistillation,
      sourceDistillation,
    }),
  );

  return doctorPipelineAutomationDomainSchema.parse({
    status: reasonResolution.status,
    checkedAt: nowIso(),
    summary: reasonResolution.summary,
    reasons: reasonResolution.reasons,
    reasonDetails: reasonResolution.reasonDetails,
    skippedChecks: reasonResolution.skippedChecks,
    runs,
    agentLogSync,
    vibeDistillation,
    sourceDistillation,
  });
}

export async function runDoctorDomain(
  domain: DoctorDomainName,
  rawOptions?: DoctorOptions,
): Promise<DoctorDomainReport> {
  if (domain === "core-infrastructure") return runDoctorCoreInfrastructure(rawOptions);
  if (domain === "ai-service-tools") return runDoctorAiServiceTools(rawOptions);
  return runDoctorPipelineAutomation(rawOptions);
}
