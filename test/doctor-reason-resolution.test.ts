import { describe, expect, test } from "vitest";
import {
  appendAutomationReasons,
  createReasonResolutionContext,
  resolveReasonDetails,
} from "../src/modules/doctor/doctor-reason-resolution.js";
import type { DoctorReport } from "../src/shared/schemas/doctor.schema.js";

const loadedLaunchAgent = {
  label: "com.memory-router.queue-supervisor",
  plistPath: "/tmp/queue-supervisor.plist",
  installed: true,
  loaded: true,
  state: "running",
};

function createDistillationHealth(
  overrides: Partial<DoctorReport["vibeDistillation"]> = {},
): DoctorReport["vibeDistillation"] {
  return {
    inputSources: {
      sources: 1,
      fragments: 0,
    },
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
      total: 1,
      queued: 1,
      running: 0,
      paused: 0,
      failed: 0,
      failedLast24h: 0,
      failedLast7d: 0,
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

function createIdleDistillationHealth(
  overrides: Partial<DoctorReport["vibeDistillation"]> = {},
): DoctorReport["vibeDistillation"] {
  const base = createDistillationHealth();
  return {
    ...base,
    inputSources: {
      sources: 0,
      fragments: 0,
    },
    runs: {
      ...base.runs,
      totalRuns: 0,
      okRuns: 0,
      skippedRuns: 0,
      failedRuns: 0,
      lastRunAt: null,
      lastRunAgeMinutes: null,
      lastOkRunAt: null,
      lastOkRunAgeMinutes: null,
    },
    jobs: {
      total: 0,
      queued: 0,
      running: 0,
      paused: 0,
      failed: 0,
      failedLast24h: 0,
      failedLast7d: 0,
      lastPausedAt: null,
      lastError: null,
    },
    queueHealth: {
      ...base.queueHealth,
      queued: 0,
      running: 0,
      retryablePaused: 0,
      staleRunning: 0,
      blockedByHigherPriority: false,
      oldestQueuedAt: null,
      oldestQueuedAgeMinutes: null,
      oldestRunningAt: null,
      oldestRunningAgeMinutes: null,
    },
    ...overrides,
  };
}

describe("doctor reason resolution", () => {
  test("keeps low-impact operational signals out of degraded status", () => {
    const options = {
      windowSize: 20,
      freshnessThresholdMinutes: 720,
      degradedRateThreshold: 0.5,
      strict: true,
    };
    const result = resolveReasonDetails(
      ["KNOWLEDGE_ZERO_USE_HIGH", "VIBE_DISTILLATION_STALE"],
      createReasonResolutionContext(options, {
        knowledgeLifecycle: {
          activeCount: 100,
          zeroUseActiveCount: 90,
          staleByDecayCount: 0,
          staleProcedureCount: 0,
          dynamicScoreAvg: null,
          dynamicScoreP95: null,
          lastCompiledAt: null,
          lastCompiledAgeMinutes: null,
          thresholds: {
            staleDecayFactor: 0.5,
            zeroUseWarningMinActiveCount: 10,
          },
        },
        vibeDistillation: createDistillationHealth(),
      }),
    );

    expect(result.status).toBe("ok");
    expect(result.summary).toMatchObject({
      blocking: 0,
      degraded: 0,
      maintenance: 2,
      skipped: 0,
    });
    expect(result.reasonDetails.map((detail) => detail.impactLevel)).toEqual([
      "maintenance",
      "maintenance",
    ]);
  });

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

  test("does not warn for source distillation when there is no source input or history", () => {
    const reasons: string[] = [];
    appendAutomationReasons(
      reasons,
      {
        windowSize: 20,
        freshnessThresholdMinutes: 720,
        degradedRateThreshold: 0.5,
        strict: false,
      },
      {
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
        launchAgent: loadedLaunchAgent,
        nextActions: [],
      },
      createDistillationHealth(),
      createIdleDistillationHealth(),
    );

    expect(reasons).not.toContain("SOURCE_DISTILLATION_NEVER_RAN");
    expect(reasons).not.toContain("SOURCE_DISTILLATION_STALE");
    expect(reasons).not.toContain("SOURCE_DISTILLATION_LAUNCH_AGENT_NOT_INSTALLED");
    expect(reasons).not.toContain("SOURCE_DISTILLATION_LAUNCH_AGENT_NOT_LOADED");
  });

  test("warns for source distillation when source input exists but no run exists", () => {
    const reasons: string[] = [];
    appendAutomationReasons(
      reasons,
      {
        windowSize: 20,
        freshnessThresholdMinutes: 720,
        degradedRateThreshold: 0.5,
        strict: false,
      },
      {
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
        launchAgent: loadedLaunchAgent,
        nextActions: [],
      },
      createDistillationHealth(),
      createIdleDistillationHealth({
        inputSources: {
          sources: 1,
          fragments: 0,
        },
      }),
    );

    expect(reasons).toContain("SOURCE_DISTILLATION_NEVER_RAN");
  });

  test("does not warn when source distillation success run is only old", () => {
    const reasons: string[] = [];
    appendAutomationReasons(
      reasons,
      {
        windowSize: 20,
        freshnessThresholdMinutes: 720,
        degradedRateThreshold: 0.5,
        strict: false,
      },
      {
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
        launchAgent: loadedLaunchAgent,
        nextActions: [],
      },
      createDistillationHealth(),
      createDistillationHealth({
        runs: {
          totalRuns: 1,
          okRuns: 1,
          skippedRuns: 0,
          outcomeKindCounts: [],
          skippedRunReasons: [],
          failedRuns: 0,
          lastRunAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
          lastRunAgeMinutes: 10 * 24 * 60,
          lastOkRunAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
          lastOkRunAgeMinutes: 10 * 24 * 60,
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
          ...createDistillationHealth().queueHealth,
          queued: 0,
          running: 0,
          retryablePaused: 0,
          staleRunning: 0,
          blockedByHigherPriority: false,
        },
      }),
    );

    expect(reasons).not.toContain("SOURCE_DISTILLATION_STALE");
  });

  test("does not warn on old failed backlog when the failed rate and recent failures are low", () => {
    const reasons: string[] = [];
    appendAutomationReasons(
      reasons,
      {
        windowSize: 20,
        freshnessThresholdMinutes: 720,
        degradedRateThreshold: 0.5,
        strict: false,
      },
      {
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
        launchAgent: loadedLaunchAgent,
        nextActions: [],
      },
      createDistillationHealth({
        inputSources: { sources: 3709, fragments: 0 },
        jobs: {
          total: 20012,
          queued: 0,
          running: 0,
          paused: 0,
          failed: 199,
          failedLast24h: 0,
          failedLast7d: 4,
          lastPausedAt: null,
          lastError: null,
        },
      }),
      createIdleDistillationHealth(),
    );

    expect(reasons).not.toContain("VIBE_DISTILLATION_FAILED_BACKLOG_HIGH");
    expect(reasons).not.toContain("VIBE_DISTILLATION_FAILED_BACKLOG_CRITICAL");
  });

  test("warns when failed backlog is large relative to the queue volume", () => {
    const reasons: string[] = [];
    appendAutomationReasons(
      reasons,
      {
        windowSize: 20,
        freshnessThresholdMinutes: 720,
        degradedRateThreshold: 0.5,
        strict: false,
      },
      {
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
        launchAgent: loadedLaunchAgent,
        nextActions: [],
      },
      createDistillationHealth({
        jobs: {
          total: 1000,
          queued: 0,
          running: 0,
          paused: 0,
          failed: 60,
          failedLast24h: 0,
          failedLast7d: 0,
          lastPausedAt: null,
          lastError: null,
        },
      }),
      createIdleDistillationHealth(),
    );

    expect(reasons).toContain("VIBE_DISTILLATION_FAILED_BACKLOG_HIGH");
    expect(reasons).not.toContain("VIBE_DISTILLATION_FAILED_BACKLOG_CRITICAL");
  });

  test("marks failed backlog critical when recent failures surge", () => {
    const reasons: string[] = [];
    appendAutomationReasons(
      reasons,
      {
        windowSize: 20,
        freshnessThresholdMinutes: 720,
        degradedRateThreshold: 0.5,
        strict: false,
      },
      {
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
        launchAgent: loadedLaunchAgent,
        nextActions: [],
      },
      createDistillationHealth({
        jobs: {
          total: 20012,
          queued: 0,
          running: 0,
          paused: 0,
          failed: 220,
          failedLast24h: 25,
          failedLast7d: 60,
          lastPausedAt: null,
          lastError: null,
        },
      }),
      createIdleDistillationHealth(),
    );

    expect(reasons).toContain("VIBE_DISTILLATION_FAILED_BACKLOG_HIGH");
    expect(reasons).toContain("VIBE_DISTILLATION_FAILED_BACKLOG_CRITICAL");
  });
});
