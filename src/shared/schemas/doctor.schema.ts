import { z } from "zod";

const doctorStatusSchema = z.enum(["ok", "degraded", "failed"]);

const launchAgentSchema = z.object({
  label: z.string(),
  plistPath: z.string(),
  installed: z.boolean(),
  loaded: z.boolean(),
  state: z.string().nullable(),
});

const skippedRunReasonSchema = z.object({
  reason: z.string(),
  count: z.number().int().nonnegative(),
});

const distillationQueueHealthSchema = z.object({
  queued: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  retryablePaused: z.number().int().nonnegative(),
  staleRunning: z.number().int().nonnegative(),
  blockedByHigherPriority: z.boolean(),
  oldestQueuedAt: z.string().datetime().nullable(),
  oldestQueuedAgeMinutes: z.number().nonnegative().nullable(),
  oldestRunningAt: z.string().datetime().nullable(),
  oldestRunningAgeMinutes: z.number().nonnegative().nullable(),
  lock: z.object({
    path: z.string(),
    exists: z.boolean(),
    pid: z.number().int().positive().nullable(),
    createdAt: z.string().datetime().nullable(),
    ageSeconds: z.number().nonnegative().nullable(),
    staleByCreatedAge: z.boolean(),
  }),
});

const doctorReasonSeveritySchema = z.enum(["critical", "warning", "info"]);
const doctorReasonAreaSchema = z.enum([
  "Knowledge",
  "Distillation",
  "Sync",
  "Runtime",
  "MCP",
  "Other",
]);
const doctorReasonDetailSchema = z.object({
  code: z.string(),
  label: z.string(),
  severity: doctorReasonSeveritySchema,
  area: doctorReasonAreaSchema,
  description: z.string(),
  impact: z.string(),
  action: z.string(),
});

export const doctorDistillationHealthSchema = z.object({
  launchAgent: launchAgentSchema,
  runs: z.object({
    totalRuns: z.number().int().nonnegative(),
    okRuns: z.number().int().nonnegative(),
    skippedRuns: z.number().int().nonnegative(),
    outcomeKindCounts: z.array(skippedRunReasonSchema),
    skippedRunReasons: z.array(skippedRunReasonSchema),
    failedRuns: z.number().int().nonnegative(),
    lastRunAt: z.string().datetime().nullable(),
    lastRunAgeMinutes: z.number().nonnegative().nullable(),
    lastOkRunAt: z.string().datetime().nullable(),
    lastOkRunAgeMinutes: z.number().nonnegative().nullable(),
  }),
  jobs: z.object({
    queued: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
    paused: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    lastPausedAt: z.string().datetime().nullable(),
    lastError: z.string().nullable(),
  }),
  queueHealth: distillationQueueHealthSchema,
  nextActions: z.array(z.string()),
});

export const doctorReportSchema = z.object({
  status: doctorStatusSchema,
  checkedAt: z.string().datetime(),
  reasons: z.array(z.string()),
  reasonDetails: z.array(doctorReasonDetailSchema),
  db: z.object({
    reachable: z.boolean(),
    durationMs: z.number().int().nonnegative(),
    error: z.string().optional(),
  }),
  vector: z.object({
    installed: z.boolean(),
  }),
  embedding: z.object({
    configured: z.boolean(),
    provider: z.string(),
    daemon: z.object({
      url: z.string(),
      reachable: z.boolean(),
      error: z.string().optional(),
    }),
    cli: z.object({
      python: z.string(),
      root: z.string(),
      modelDir: z.string(),
      usable: z.boolean(),
      error: z.string().optional(),
    }),
  }),
  agenticLlm: z.object({
    providerSetting: z.string(),
    selectedProvider: z.string().optional(),
    fallbackOrder: z.array(z.string()),
    provider: z.string(),
    configured: z.boolean(),
    reachable: z.boolean(),
    model: z.string(),
    endpoint: z.string(),
    error: z.string().optional(),
  }),
  tables: z.object({
    expected: z.array(z.string()),
    existing: z.array(z.string()),
    missing: z.array(z.string()),
  }),
  runs: z.object({
    windowSize: z.number().int().positive(),
    totalRuns: z.number().int().nonnegative(),
    degradedRuns: z.number().int().nonnegative(),
    degradedRate: z.number().min(0).max(1),
    blockingRuns: z.number().int().nonnegative().optional(),
    blockingRate: z.number().min(0).max(1).optional(),
    usableRuns: z.number().int().nonnegative().optional(),
    usableRate: z.number().min(0).max(1).optional(),
    warningOnlyRuns: z.number().int().nonnegative().optional(),
    warningOnlyRate: z.number().min(0).max(1).optional(),
    noContentRuns: z.number().int().nonnegative().optional(),
    noContentRate: z.number().min(0).max(1).optional(),
    durationMsP50: z.number().nonnegative().nullable(),
    durationMsP95: z.number().nonnegative().nullable(),
    durationMsAvg: z.number().nonnegative().nullable(),
    lastRunAt: z.string().datetime().nullable(),
    lastRunAgeMinutes: z.number().nonnegative().nullable(),
    freshnessThresholdMinutes: z.number().int().positive(),
    degradedRateThreshold: z.number().min(0).max(1),
  }),
  hitl: z.object({
    draftCount: z.number().int().nonnegative(),
    oldestDraftAt: z.string().datetime().nullable(),
    oldestDraftAgeMinutes: z.number().nonnegative().nullable(),
    backlogThresholdCount: z.number().int().positive(),
    backlogThresholdAgeMinutes: z.number().int().positive(),
  }),
  knowledgeLifecycle: z.object({
    activeCount: z.number().int().nonnegative(),
    zeroUseActiveCount: z.number().int().nonnegative(),
    staleByDecayCount: z.number().int().nonnegative(),
    staleProcedureCount: z.number().int().nonnegative(),
    dynamicScoreAvg: z.number().nonnegative().nullable(),
    dynamicScoreP95: z.number().nonnegative().nullable(),
    lastCompiledAt: z.string().datetime().nullable(),
    lastCompiledAgeMinutes: z.number().nonnegative().nullable(),
    thresholds: z.object({
      staleDecayFactor: z.number().min(0).max(1),
      zeroUseWarningMinActiveCount: z.number().int().positive(),
    }),
  }),
  mcp: z.object({
    exposedTools: z.array(z.string()),
    requiredPrimaryTools: z.array(z.string()),
    missingPrimaryTools: z.array(z.string()),
    staleKnowledgeCount: z.number().int().nonnegative(),
    staleSourceCount: z.number().int().nonnegative(),
    nextActions: z.array(z.string()),
  }),
  agentLogSync: z.object({
    codex: z.object({
      sessionDir: z.string(),
      sessionDirExists: z.boolean(),
      archivedSessionDir: z.string(),
      archivedSessionDirExists: z.boolean(),
    }),
    antigravity: z.object({
      logDir: z.string(),
      configured: z.boolean(),
      exists: z.boolean(),
    }),
    states: z.array(
      z.object({
        id: z.string(),
        lastSyncedAt: z.string().datetime().nullable(),
        lastSyncedAgeMinutes: z.number().nonnegative().nullable(),
        cursorFiles: z.number().int().nonnegative(),
        skipped: z.boolean(),
        warnings: z.array(z.string()),
      }),
    ),
    launchAgent: launchAgentSchema,
    nextActions: z.array(z.string()),
  }),
  vibeDistillation: doctorDistillationHealthSchema,
  sourceDistillation: doctorDistillationHealthSchema,
});

export type DoctorReport = z.infer<typeof doctorReportSchema>;
export type DoctorDistillationHealth = z.infer<typeof doctorDistillationHealthSchema>;
