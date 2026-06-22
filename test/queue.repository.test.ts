import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  fetchQueueDashboardStats,
  normalizeQueueLastError,
} from "../api/modules/queue/queue.repository.js";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  getQueueControlStates: vi.fn(),
}));

vi.mock("../src/db/index.js", () => ({
  db: {
    execute: mocks.execute,
  },
}));

vi.mock("../src/modules/queue/core/index.js", () => ({
  appendQueueEvent: vi.fn(),
  pauseQueueJob: vi.fn(),
  resumeQueueJob: vi.fn(),
  retryQueueJob: vi.fn(),
  getQueueControlStates: mocks.getQueueControlStates,
  pauseRunningQueueJobs: vi.fn(),
  setQueuePaused: vi.fn(),
}));

function aggregateRow(overrides: Record<string, unknown> = {}) {
  return {
    status: "completed",
    count: 0,
    oldest_pending_at: null,
    offline_count: 0,
    non_registered_count: 0,
    ...overrides,
  };
}

describe("queue repository stats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getQueueControlStates.mockResolvedValue({
      findingCandidate: { paused: false, updatedAt: null, updatedBy: null, reason: null },
      episodeDistiller: { paused: false, updatedAt: null, updatedBy: null, reason: null },
      coveringEvidence: { paused: false, updatedAt: null, updatedBy: null, reason: null },
      deadZoneMergeReview: { paused: false, updatedAt: null, updatedBy: null, reason: null },
      finalizeDistille: { paused: false, updatedAt: null, updatedBy: null, reason: null },
      mergeActivationFinalize: { paused: false, updatedAt: null, updatedBy: null, reason: null },
    });
  });

  test("reports non-registered counts for covering queue stats", async () => {
    const rowsByQueue = [
      [aggregateRow({ status: "completed", count: 1, non_registered_count: 4 })],
      [aggregateRow({ status: "completed", count: 2, non_registered_count: 8 })],
      [aggregateRow({ status: "completed", count: 3, non_registered_count: 2 })],
      [aggregateRow({ status: "completed", count: 4, non_registered_count: 5 })],
      [aggregateRow({ status: "completed", count: 5, non_registered_count: 7 })],
      [aggregateRow({ status: "completed", count: 6, non_registered_count: 9 })],
    ];
    mocks.execute.mockImplementation(async () => ({
      rows: rowsByQueue.shift() ?? [],
    }));

    const stats = await fetchQueueDashboardStats();

    expect(stats.queues.findingCandidate.nonRegistered).toBe(0);
    expect(stats.queues.coveringEvidence.nonRegistered).toBe(2);
    expect(stats.queues.finalizeDistille.nonRegistered).toBe(0);
    expect("mergeActivationFinalize" in stats.queues).toBe(false);
    expect("mergeActivationFinalize" in stats.queueControls).toBe(false);
    expect(stats.totals.nonRegistered).toBe(2);
  });
});

describe("queue repository error labels", () => {
  test("normalizes legacy findingCandidate tool-loop failures to evidence exhaustion", () => {
    expect(
      normalizeQueueLastError("findingCandidate", "distillation tool loop exceeded max rounds (8)"),
    ).toBe(
      "findCandidate evidence_not_found: exhausted 8/8 reader tool calls without producing a final candidate response",
    );
  });

  test("keeps non-finding queue errors unchanged", () => {
    expect(
      normalizeQueueLastError("coveringEvidence", "distillation tool loop exceeded max rounds (8)"),
    ).toBe("distillation tool loop exceeded max rounds (8)");
  });
});
