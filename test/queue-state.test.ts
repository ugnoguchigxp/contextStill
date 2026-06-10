import { beforeEach, describe, expect, test, vi } from "vitest";
import { db } from "../src/db/index.js";
import {
  keepQueueJobWaitingForWorker,
  pauseQueueJob,
  pauseRunningQueueJobs,
  resumeQueueJob,
  retryQueueJob,
} from "../src/modules/queue/core/state.js";

vi.mock("../src/db/index.js", () => ({
  db: {
    execute: vi.fn(),
  },
}));

function chunkText(chunk: unknown): string {
  if (typeof chunk === "string") return chunk;
  if (chunk && typeof chunk === "object" && "value" in chunk) {
    const value = (chunk as { value?: unknown }).value;
    if (Array.isArray(value)) return value.join("");
  }
  return "";
}

describe("queue state transitions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.execute).mockResolvedValue({ rows: [{ id: "job-1", status: "pending" }] } as any);
  });

  test("casts retry metadata parameters before jsonb_build_object", async () => {
    await retryQueueJob({
      queueName: "findingCandidate",
      id: "job-1",
      mode: "default",
      forceRefreshEvidence: true,
      reason: "requeued from queue dashboard",
    });

    const sqlQuery = vi.mocked(db.execute).mock.calls[0]?.[0] as
      | { queryChunks?: unknown[] }
      | undefined;
    const rendered = sqlQuery?.queryChunks?.map(chunkText).join("");

    expect(rendered).toContain("'forceRefreshEvidence', ::boolean");
    expect(rendered).toContain("'retryMode', default::text");
    expect(rendered).toContain("'retryReason', requeued from queue dashboard::text");
  });

  test("retryQueueJob with finalizeDistille", async () => {
    await retryQueueJob({
      queueName: "finalizeDistille",
      id: "job-2",
      mode: "cloud_api",
      forceRefreshEvidence: false,
    });
    const sqlQuery = vi.mocked(db.execute).mock.calls[0]?.[0] as
      | { queryChunks?: unknown[] }
      | undefined;
    const rendered = sqlQuery?.queryChunks?.map(chunkText).join("");
    expect(rendered).toContain("provider_policy = case");
    expect(rendered).toContain("metadata = coalesce");
  });

  test("retryQueueJob with deadZoneMergeReview", async () => {
    await retryQueueJob({
      queueName: "deadZoneMergeReview",
      id: "job-3",
      mode: "default",
      forceRefreshEvidence: true,
    });
    const sqlQuery = vi.mocked(db.execute).mock.calls[0]?.[0] as
      | { queryChunks?: unknown[] }
      | undefined;
    const rendered = sqlQuery?.queryChunks?.map(chunkText).join("");
    expect(rendered).toContain("attempt_count = 0");
    expect(rendered).toContain("payload = coalesce");
  });

  test("retryQueueJob with default other queue", async () => {
    await retryQueueJob({
      queueName: "contextCompile" as any,
      id: "job-4",
      mode: "default",
      forceRefreshEvidence: true,
    });
    const sqlQuery = vi.mocked(db.execute).mock.calls[0]?.[0] as
      | { queryChunks?: unknown[] }
      | undefined;
    const rendered = sqlQuery?.queryChunks?.map(chunkText).join("");
    expect(rendered).toContain("provider_policy = case");
  });

  test("pauseQueueJob updates status to paused", async () => {
    await pauseQueueJob({
      queueName: "findingCandidate",
      id: "job-1",
      reason: "pause reason",
    });

    const sqlQuery = vi.mocked(db.execute).mock.calls[0]?.[0] as
      | { queryChunks?: unknown[] }
      | undefined;
    const rendered = sqlQuery?.queryChunks?.map(chunkText).join("");
    expect(rendered).toContain("status = 'paused'");
    expect(rendered).toContain("last_error = pause reason");
  });

  test("keepQueueJobWaitingForWorker updates pending for finalizeDistille", async () => {
    await keepQueueJobWaitingForWorker({
      queueName: "finalizeDistille",
      id: "job-1",
      reason: "wait reason",
    });
    const sqlQuery = vi.mocked(db.execute).mock.calls[0]?.[0] as
      | { queryChunks?: unknown[] }
      | undefined;
    const rendered = sqlQuery?.queryChunks?.map(chunkText).join("");
    expect(rendered).toContain("status = 'pending'");
    expect(rendered).not.toContain("next_run_at");
  });

  test("keepQueueJobWaitingForWorker updates pending for other queues", async () => {
    await keepQueueJobWaitingForWorker({
      queueName: "findingCandidate",
      id: "job-1",
      reason: "wait reason",
    });
    const sqlQuery = vi.mocked(db.execute).mock.calls[0]?.[0] as
      | { queryChunks?: unknown[] }
      | undefined;
    const rendered = sqlQuery?.queryChunks?.map(chunkText).join("");
    expect(rendered).toContain("status = 'pending'");
    expect(rendered).toContain("next_run_at = null");
  });

  test("resumeQueueJob sets status back to pending for finalizeDistille", async () => {
    await resumeQueueJob({
      queueName: "finalizeDistille",
      id: "job-1",
    });
    const sqlQuery = vi.mocked(db.execute).mock.calls[0]?.[0] as
      | { queryChunks?: unknown[] }
      | undefined;
    const rendered = sqlQuery?.queryChunks?.map(chunkText).join("");
    expect(rendered).toContain("status = 'pending'");
    expect(rendered).not.toContain("next_run_at");
  });

  test("resumeQueueJob sets status back to pending for other queues", async () => {
    await resumeQueueJob({
      queueName: "findingCandidate",
      id: "job-1",
    });
    const sqlQuery = vi.mocked(db.execute).mock.calls[0]?.[0] as
      | { queryChunks?: unknown[] }
      | undefined;
    const rendered = sqlQuery?.queryChunks?.map(chunkText).join("");
    expect(rendered).toContain("status = 'pending'");
    expect(rendered).toContain("next_run_at = null");
  });

  test("pauseRunningQueueJobs pauses all running jobs for finalizeDistille", async () => {
    vi.mocked(db.execute).mockResolvedValueOnce({ rowCount: 5 } as any);
    const count = await pauseRunningQueueJobs({
      queueName: "finalizeDistille",
      reason: "global pause",
    });
    expect(count).toBe(5);
    const sqlQuery = vi.mocked(db.execute).mock.calls[0]?.[0] as
      | { queryChunks?: unknown[] }
      | undefined;
    const rendered = sqlQuery?.queryChunks?.map(chunkText).join("");
    expect(rendered).toContain("status = 'paused'");
    expect(rendered).not.toContain("next_run_at");
  });

  test("pauseRunningQueueJobs pauses all running jobs for other queues", async () => {
    vi.mocked(db.execute).mockResolvedValueOnce({ rowCount: 10 } as any);
    const count = await pauseRunningQueueJobs({
      queueName: "findingCandidate",
    });
    expect(count).toBe(10);
    const sqlQuery = vi.mocked(db.execute).mock.calls[0]?.[0] as
      | { queryChunks?: unknown[] }
      | undefined;
    const rendered = sqlQuery?.queryChunks?.map(chunkText).join("");
    expect(rendered).toContain("status = 'paused'");
    expect(rendered).toContain("next_run_at = now()");
  });
});
