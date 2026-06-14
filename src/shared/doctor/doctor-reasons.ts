import {
  type DoctorReasonArea,
  type DoctorReasonCatalogEntry,
  type DoctorReasonCommands,
  type DoctorReasonDetail,
  type DoctorReasonEnvironmentScope,
  type DoctorReasonImpactLevel,
  type DoctorReasonSeverity,
  doctorReasonCatalog,
} from "./doctor-reason-catalog.js";

export {
  doctorReasonCatalog,
  type DoctorReasonArea,
  type DoctorReasonCatalogEntry,
  type DoctorReasonCommands,
  type DoctorReasonDetail,
  type DoctorReasonEnvironmentScope,
  type DoctorReasonImpactLevel,
  type DoctorReasonSeverity,
};

type ImpactRule = {
  normal: Exclude<DoctorReasonImpactLevel, "skipped">;
  strict?: Exclude<DoctorReasonImpactLevel, "skipped">;
};

const impactRules: Partial<Record<string, ImpactRule>> = {
  DB_UNREACHABLE: { normal: "blocking" },
  MISSING_REQUIRED_TABLES: { normal: "blocking" },
  REQUIRED_TABLES_CHECK_FAILED: { normal: "blocking" },
  MCP_PRIMARY_TOOLS_MISSING: { normal: "blocking" },
  VIBE_DISTILLATION_QUEUE_STALE_RUNNING: { normal: "blocking" },
  VIBE_DISTILLATION_PIPELINE_LOCK_STALE: { normal: "blocking" },
  VIBE_DISTILLATION_QUEUE_STOPPED: { normal: "blocking" },
  SOURCE_DISTILLATION_QUEUE_STALE_RUNNING: { normal: "blocking" },
  SOURCE_DISTILLATION_PIPELINE_LOCK_STALE: { normal: "blocking" },
  SOURCE_DISTILLATION_QUEUE_STOPPED: { normal: "blocking" },
  AGENTIC_LLM_NOT_CONFIGURED: { normal: "maintenance", strict: "degraded" },
  AGENTIC_LLM_UNREACHABLE: { normal: "maintenance", strict: "degraded" },
  KNOWLEDGE_ZERO_USE_HIGH: { normal: "maintenance" },
  HITL_DRAFT_BACKLOG_HIGH: { normal: "maintenance", strict: "degraded" },
  HITL_DRAFT_REVIEW_STALE: { normal: "maintenance", strict: "degraded" },
  KNOWLEDGE_DECAY_STALE_HIGH: { normal: "maintenance", strict: "degraded" },
  VIBE_DISTILLATION_STALE: { normal: "maintenance" },
  VIBE_DISTILLATION_FAILED_BACKLOG_HIGH: { normal: "maintenance" },
  VIBE_DISTILLATION_FAILED_BACKLOG_CRITICAL: { normal: "maintenance", strict: "degraded" },
  SOURCE_DISTILLATION_STALE: { normal: "maintenance" },
  SOURCE_DISTILLATION_FAILED_BACKLOG_HIGH: { normal: "maintenance" },
  SOURCE_DISTILLATION_FAILED_BACKLOG_CRITICAL: { normal: "maintenance", strict: "degraded" },
  NO_COMPILE_RUN_HISTORY: { normal: "maintenance" },
  RUN_HEALTH_SKIPPED_TABLE_MISSING: { normal: "maintenance" },
};

const environmentScopeRules: Partial<Record<string, DoctorReasonEnvironmentScope>> = {
  AGENT_LOG_SYNC_NEVER_RAN: "configured_only",
  CODEX_LOGS_SYNC_STALE: "configured_only",
  CODEX_LOGS_SYNC_WARNINGS: "configured_only",
  ANTIGRAVITY_LOGS_SYNC_STALE: "configured_only",
  ANTIGRAVITY_LOGS_SYNC_WARNINGS: "configured_only",
  VIBE_DISTILLATION_NEVER_RAN: "configured_only",
  VIBE_DISTILLATION_STALE: "configured_only",
  VIBE_DISTILLATION_FAILED_BACKLOG_HIGH: "configured_only",
  VIBE_DISTILLATION_FAILED_BACKLOG_CRITICAL: "configured_only",
  SOURCE_DISTILLATION_NEVER_RAN: "configured_only",
  SOURCE_DISTILLATION_STALE: "configured_only",
  SOURCE_DISTILLATION_FAILED_BACKLOG_HIGH: "configured_only",
  SOURCE_DISTILLATION_FAILED_BACKLOG_CRITICAL: "configured_only",

  DEGRADED_RATE_HIGH: "non_empty_db",
  USABLE_PACK_RATE_LOW: "non_empty_db",
  KNOWLEDGE_ZERO_USE_HIGH: "non_empty_db",
  HITL_DRAFT_BACKLOG_HIGH: "non_empty_db",
  HITL_DRAFT_REVIEW_STALE: "non_empty_db",
};

const commandHints: Partial<Record<string, DoctorReasonCommands>> = {
  VIBE_DISTILLATION_QUEUE_STALE_RUNNING: {
    inspect: "bun run doctor",
    repairDryRun: null,
    repairApply: "bun run queue:finding:once",
  },
  VIBE_DISTILLATION_PIPELINE_LOCK_STALE: {
    inspect: "bun run doctor",
    repairDryRun: null,
    repairApply: "bun run queue:finding:once",
  },
  VIBE_DISTILLATION_QUEUE_STOPPED: {
    inspect: "bun run doctor",
    repairDryRun: null,
    repairApply: null,
  },
  SOURCE_DISTILLATION_QUEUE_STALE_RUNNING: {
    inspect: "bun run doctor",
    repairDryRun: null,
    repairApply: "bun run queue:finding:once",
  },
  SOURCE_DISTILLATION_PIPELINE_LOCK_STALE: {
    inspect: "bun run doctor",
    repairDryRun: null,
    repairApply: "bun run queue:finding:once",
  },
  SOURCE_DISTILLATION_QUEUE_STOPPED: {
    inspect: "bun run doctor",
    repairDryRun: null,
    repairApply: null,
  },
};

function titleCaseFromCode(code: string): string {
  return code
    .toLowerCase()
    .split("_")
    .map((word) => (word.length === 0 ? word : word[0].toUpperCase() + word.slice(1)))
    .join(" ");
}

function inferArea(code: string): DoctorReasonArea {
  if (code.startsWith("KNOWLEDGE_")) return "Knowledge";
  if (code.startsWith("VIBE_DISTILLATION_") || code.startsWith("SOURCE_DISTILLATION_")) {
    return "Distillation";
  }
  if (
    code.includes("_SYNC_") ||
    code.startsWith("AGENT_LOG_") ||
    code.startsWith("ANTIGRAVITY_") ||
    code.startsWith("CODEX_SESSION_")
  ) {
    return "Sync";
  }
  if (code.startsWith("MCP_")) return "MCP";
  if (
    code.startsWith("DB_") ||
    code.startsWith("VECTOR_") ||
    code.startsWith("EMBEDDING_") ||
    code.startsWith("AGENTIC_LLM_") ||
    code.startsWith("RUN_HEALTH_") ||
    code.startsWith("CONTEXT_COMPILE_") ||
    code.startsWith("DEGRADED_RATE_") ||
    code.startsWith("USABLE_PACK_") ||
    code.startsWith("NO_COMPILE_RUN_")
  ) {
    return "Runtime";
  }
  return "Other";
}

function inferSeverity(code: string): DoctorReasonSeverity {
  if (
    code === "DB_UNREACHABLE" ||
    code === "MISSING_REQUIRED_TABLES" ||
    code === "REQUIRED_TABLES_CHECK_FAILED" ||
    code.endsWith("_PIPELINE_LOCK_STALE") ||
    code.endsWith("_QUEUE_STOPPED")
  ) {
    return "critical";
  }
  if (
    code.endsWith("_STALE") ||
    code.endsWith("_MISSING") ||
    code.endsWith("_HIGH") ||
    code.endsWith("_UNREACHABLE") ||
    code.endsWith("_NOT_CONFIGURED") ||
    code.endsWith("_NOT_LOADED") ||
    code.endsWith("_FAILED") ||
    code.endsWith("_WARNINGS") ||
    code.endsWith("_SKIPPED")
  ) {
    return "warning";
  }
  return "info";
}

function defaultImpactLevelFromSeverity(
  severity: DoctorReasonSeverity,
): Exclude<DoctorReasonImpactLevel, "skipped"> {
  if (severity === "critical") return "blocking";
  if (severity === "warning") return "degraded";
  return "maintenance";
}

type FormatDoctorReasonDetailOptions = {
  strict?: boolean;
  impactLevel?: DoctorReasonImpactLevel;
  environmentScope?: DoctorReasonEnvironmentScope;
  commands?: DoctorReasonCommands;
  evidence?: Record<string, unknown> | null;
};

export function resolveDoctorReasonImpactLevel(
  code: string,
  severity: DoctorReasonSeverity,
  strict = false,
): Exclude<DoctorReasonImpactLevel, "skipped"> {
  const rule = impactRules[code];
  if (!rule) return defaultImpactLevelFromSeverity(severity);
  return strict ? (rule.strict ?? rule.normal) : rule.normal;
}

export function resolveDoctorReasonEnvironmentScope(code: string): DoctorReasonEnvironmentScope {
  return environmentScopeRules[code] ?? "all";
}

export function resolveDoctorReasonCommands(code: string): DoctorReasonCommands | undefined {
  return commandHints[code];
}

export function formatDoctorReasonDetail(
  code: string,
  options: FormatDoctorReasonDetailOptions = {},
): DoctorReasonDetail {
  const fromCatalog = doctorReasonCatalog[code];
  const severity = fromCatalog?.severity ?? inferSeverity(code);
  const detailBase =
    fromCatalog ??
    ({
      label: titleCaseFromCode(code),
      severity,
      area: inferArea(code),
      description: "Doctor が未定義の診断コードを返しました。",
      impact: "原因の重要度や対応順序を判断しにくくなります。",
      action: "raw code を検索し、doctor.service.ts の reason 生成箇所を確認してください。",
    } satisfies DoctorReasonCatalogEntry);

  return {
    code,
    ...detailBase,
    impactLevel:
      options.impactLevel ??
      resolveDoctorReasonImpactLevel(code, detailBase.severity, options.strict),
    environmentScope: options.environmentScope ?? resolveDoctorReasonEnvironmentScope(code),
    commands: options.commands ?? resolveDoctorReasonCommands(code),
    evidence: options.evidence ?? null,
  };
}
