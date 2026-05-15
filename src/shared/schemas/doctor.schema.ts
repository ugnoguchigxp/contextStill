import { z } from "zod";

const doctorStatusSchema = z.enum(["ok", "degraded", "failed"]);

const launchAgentSchema = z.object({
  label: z.string(),
  plistPath: z.string(),
  installed: z.boolean(),
  loaded: z.boolean(),
  state: z.string().nullable(),
});

export const doctorReportSchema = z.object({
  status: doctorStatusSchema,
  checkedAt: z.string().datetime(),
  reasons: z.array(z.string()),
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
    draftFromSourceDistillationCount: z.number().int().nonnegative(),
    draftFromVibeDistillationCount: z.number().int().nonnegative(),
    backlogThresholdCount: z.number().int().positive(),
    backlogThresholdAgeMinutes: z.number().int().positive(),
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
  vibeDistillation: z.object({
    launchAgent: launchAgentSchema,
    runs: z.object({
      totalRuns: z.number().int().nonnegative(),
      okRuns: z.number().int().nonnegative(),
      skippedRuns: z.number().int().nonnegative(),
      failedRuns: z.number().int().nonnegative(),
      lastRunAt: z.string().datetime().nullable(),
      lastRunAgeMinutes: z.number().nonnegative().nullable(),
    }),
    nextActions: z.array(z.string()),
  }),
  sourceDistillation: z.object({
    launchAgent: launchAgentSchema,
    runs: z.object({
      totalRuns: z.number().int().nonnegative(),
      okRuns: z.number().int().nonnegative(),
      skippedRuns: z.number().int().nonnegative(),
      failedRuns: z.number().int().nonnegative(),
      lastRunAt: z.string().datetime().nullable(),
      lastRunAgeMinutes: z.number().nonnegative().nullable(),
    }),
    nextActions: z.array(z.string()),
  }),
});

export type DoctorReport = z.infer<typeof doctorReportSchema>;
