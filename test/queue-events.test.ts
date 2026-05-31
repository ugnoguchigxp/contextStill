import { describe, expect, test, vi } from "vitest";
import { db } from "../src/db/index.js";
import { distillationQueueEvents } from "../src/db/schema.js";
import { appendQueueEvent } from "../src/modules/queue/core/events.js";

vi.mock("../src/db/index.js", () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn().mockResolvedValue({} as any),
    })),
  },
}));

describe("appendQueueEvent", () => {
  test("inserts event into db with provided params", async () => {
    const mockValues = vi.fn().mockResolvedValue({} as any);
    vi.mocked(db.insert).mockReturnValue({ values: mockValues } as any);

    await appendQueueEvent({
      queueName: "findingCandidate",
      queueJobId: "job-123",
      eventType: "started",
      message: "Job started",
      metadata: { foo: "bar" },
    });

    expect(db.insert).toHaveBeenCalledWith(distillationQueueEvents);
    expect(mockValues).toHaveBeenCalledWith({
      queueName: "findingCandidate",
      queueJobId: "job-123",
      eventType: "started",
      message: "Job started",
      metadata: { foo: "bar" },
    });
  });

  test("uses null message and empty metadata by default", async () => {
    const mockValues = vi.fn().mockResolvedValue({} as any);
    vi.mocked(db.insert).mockReturnValue({ values: mockValues } as any);

    await appendQueueEvent({
      queueName: "coveringEvidence",
      queueJobId: "job-456",
      eventType: "completed",
    });

    expect(mockValues).toHaveBeenCalledWith({
      queueName: "coveringEvidence",
      queueJobId: "job-456",
      eventType: "completed",
      message: null,
      metadata: {},
    });
  });
});
