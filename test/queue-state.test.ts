import { beforeEach, describe, expect, test, vi } from "vitest";
import { db } from "../src/db/index.js";
import { retryQueueJob } from "../src/modules/queue/core/state.js";

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
});
