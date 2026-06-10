import { beforeEach, describe, expect, test, vi } from "vitest";
import { claimNextQueueJob } from "../src/modules/queue/core/claim.js";

const mockIsQueuePaused = vi.fn();
vi.mock("../src/modules/queue/core/control.js", () => ({
  isQueuePaused: (...args: any[]) => mockIsQueuePaused(...args),
}));

let mockExecuteResults: any[] = [];
vi.mock("../src/db/index.js", () => {
  const mockTx = {
    execute: vi.fn().mockImplementation(() => {
      return Promise.resolve(mockExecuteResults.shift() ?? { rows: [] });
    }),
  };
  const mockDb = {
    transaction: vi.fn().mockImplementation((callback) => callback(mockTx)),
  };
  return { db: mockDb };
});

describe("queue-claim", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsQueuePaused.mockResolvedValue(false);
    mockExecuteResults = [];
  });

  test("returns null if the queue is paused", async () => {
    mockIsQueuePaused.mockResolvedValue(true);

    const result = await claimNextQueueJob({
      queueName: "findingCandidate",
      workerId: "worker-1",
    });

    expect(result).toBeNull();
    expect(mockIsQueuePaused).toHaveBeenCalledWith("findingCandidate");
  });

  test("claims job for finalizeDistille queue when a job is available", async () => {
    mockExecuteResults = [
      { rows: [] }, // advisory lock lock result (ignored)
      { rows: [] }, // update stale running result (ignored)
      { rows: [{ id: "job-123" }] }, // picked & update result
    ];

    const result = await claimNextQueueJob({
      queueName: "finalizeDistille",
      workerId: "worker-1",
    });

    expect(result).toEqual({ id: "job-123" });
  });

  test("claims job for non-finalizeDistille queue when a job is available", async () => {
    mockExecuteResults = [
      { rows: [] }, // lock
      { rows: [] }, // update stale running
      { rows: [{ id: "job-456" }] }, // picked & update
    ];

    const result = await claimNextQueueJob({
      queueName: "findingCandidate",
      workerId: "worker-2",
    });

    expect(result).toEqual({ id: "job-456" });
  });

  test("returns null if no job is available to claim", async () => {
    mockExecuteResults = [
      { rows: [] }, // lock
      { rows: [] }, // update stale running
      { rows: [] }, // picked & update (empty)
    ];

    const result = await claimNextQueueJob({
      queueName: "findingCandidate",
      workerId: "worker-1",
    });

    expect(result).toBeNull();
  });
});
