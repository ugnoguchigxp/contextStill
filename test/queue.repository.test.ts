import { beforeEach, describe, expect, test, vi } from "vitest";
import { fetchQueueDashboardStats } from "../api/modules/queue/queue.repository.js";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
}));

vi.mock("../src/db/index.js", () => ({
  db: {
    execute: mocks.execute,
  },
}));

function aggregateRow(overrides: Record<string, unknown> = {}) {
  return {
    status: "completed",
    count: 0,
    oldest_pending_at: null,
    escalated_count: 0,
    offline_count: 0,
    non_registered_count: 0,
    ...overrides,
  };
}

describe("queue repository stats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("reports non-registered counts for covering queue stats", async () => {
    const rowsByQueue = [
      [aggregateRow({ status: "completed", count: 1, non_registered_count: 4 })],
      [aggregateRow({ status: "completed", count: 2, non_registered_count: 2 })],
      [aggregateRow({ status: "completed", count: 1, non_registered_count: 1 })],
      [aggregateRow({ status: "completed", count: 3, non_registered_count: 5 })],
    ];
    mocks.execute.mockImplementation(async () => ({
      rows: rowsByQueue.shift() ?? [],
    }));

    const stats = await fetchQueueDashboardStats();

    expect(stats.queues.findingCandidate.nonRegistered).toBe(0);
    expect(stats.queues.coveringEvidence.nonRegistered).toBe(2);
    expect(stats.queues.premiumCoveringEvidence.nonRegistered).toBe(1);
    expect(stats.queues.finalizeDistille.nonRegistered).toBe(0);
    expect(stats.totals.nonRegistered).toBe(3);
  });
});
