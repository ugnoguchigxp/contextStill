import { z } from "zod";

export const doctorStatusSchema = z.enum(["ok", "degraded", "failed"]);

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
    lastRunAt: z.string().datetime().nullable(),
    lastRunAgeMinutes: z.number().nonnegative().nullable(),
    freshnessThresholdMinutes: z.number().int().positive(),
    degradedRateThreshold: z.number().min(0).max(1),
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
    launchAgent: z.object({
      label: z.string(),
      plistPath: z.string(),
      installed: z.boolean(),
      loaded: z.boolean(),
      state: z.string().nullable(),
    }),
    nextActions: z.array(z.string()),
  }),
});

export type DoctorReport = z.infer<typeof doctorReportSchema>;
