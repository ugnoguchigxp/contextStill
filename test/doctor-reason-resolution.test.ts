import { describe, expect, test } from "vitest";
import { appendAutomationReasons } from "../src/modules/doctor/doctor-reason-resolution.js";
import type { DoctorReport } from "../src/shared/schemas/doctor.schema.js";

const loadedLaunchAgent = {
  label: "com.memory-router.distill-pipeline",
  plistPath: "/tmp/distill.plist",
  installed: true,
  loaded: true,
  state: "running",
};

function createDistillationHealth(
  overrides: Partial<DoctorReport["vibeDistillation"]> = {},
): DoctorReport["vibeDistillation"] {
  return {
    launchAgent: loadedLaunchAgent,
    runs: {
      totalRuns: 1,
      okRuns: 1,
      skippedRuns: 0,
      outcomeKindCounts: [],
      skippedRunReasons: [],
      failedRuns: 0,
      lastRunAt: new Date().toISOString(),
      lastRunAgeMinutes: 1,
      lastOkRunAt: new Date().toISOString(),
      lastOkRunAgeMinutes: 1,
    },
    jobs: {
      queued: 1,
      running: 0,
      paused: 0,
      failed: 0,
      lastPausedAt: null,
      lastError: null,
    },
    queueHealth: {
      queued: 1,
      running: 0,
      retryablePaused: 0,
      staleRunning: 0,
      blockedByHigherPriority: false,
      oldestQueuedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      oldestQueuedAgeMinutes: 60,
      oldestRunningAt: null,
      oldestRunningAgeMinutes: null,
      lock: {
        path: "/tmp/distill.lock",
        exists: true,
        pid: 123,
        createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        ageSeconds: 3600,
        staleByCreatedAge: true,
      },
    },
    nextActions: [],
    ...overrides,
  };
}

describe("doctor reason resolution", () => {
  test("adds pipeline lock reasons when a stale distillation lock is blocking work", () => {
    const reasons: string[] = [];
    const agentLogSync: DoctorReport["agentLogSync"] = {
      codex: {
        sessionDir: "/tmp/codex",
        sessionDirExists: true,
        archivedSessionDir: "/tmp/codex-archived",
        archivedSessionDirExists: true,
      },
      antigravity: {
        logDir: "/tmp/antigravity",
        configured: true,
        exists: true,
      },
      states: [
        {
          id: "codex_logs",
          lastSyncedAt: new Date().toISOString(),
          lastSyncedAgeMinutes: 1,
          cursorFiles: 1,
          skipped: false,
          warnings: [],
        },
      ],
      launchAgent: {
        label: "com.memory-router.agent-log-sync",
        plistPath: "/tmp/agent-log-sync.plist",
        installed: true,
        loaded: true,
        state: "running",
      },
      nextActions: [],
    };

    appendAutomationReasons(
      reasons,
      {
        windowSize: 20,
        freshnessThresholdMinutes: 720,
        degradedRateThreshold: 0.5,
        strict: false,
      },
      agentLogSync,
      createDistillationHealth(),
      createDistillationHealth(),
    );

    expect(reasons).toContain("VIBE_DISTILLATION_PIPELINE_LOCK_STALE");
    expect(reasons).toContain("SOURCE_DISTILLATION_PIPELINE_LOCK_STALE");
  });
});
