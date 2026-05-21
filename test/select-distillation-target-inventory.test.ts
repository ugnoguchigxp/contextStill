import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  memories: [] as Array<{
    id: string;
    sessionId: string;
    content: string;
    memoryType: string;
    dedupeKey: string | null;
    embedding: null;
    metadata: Record<string, unknown>;
    createdAt: Date;
  }>,
  limit: vi.fn(),
}));

vi.mock("../src/db/index.js", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        orderBy: vi.fn(() => {
          const query = Promise.resolve(mocks.memories) as Promise<typeof mocks.memories> & {
            limit: (value: number) => Promise<typeof mocks.memories>;
          };
          query.limit = (value: number) => {
            mocks.limit(value);
            return Promise.resolve(mocks.memories.slice(0, value));
          };
          return query;
        }),
      })),
    })),
  },
}));

function memory(id: string, createdAt: string) {
  return {
    id,
    sessionId: `session-${id}`,
    content: `memory ${id}`,
    memoryType: "chat",
    dedupeKey: null,
    embedding: null,
    metadata: {},
    createdAt: new Date(createdAt),
  };
}

describe("collectVibeMemoryTargetCandidates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.memories = [
      memory("memory-1", "2026-05-17T00:00:00.000Z"),
      memory("memory-2", "2026-05-18T00:00:00.000Z"),
      memory("memory-3", "2026-05-19T00:00:00.000Z"),
    ];
  });

  test("collects all vibe memories by default", async () => {
    const { collectVibeMemoryTargetCandidates } = await import(
      "../src/modules/selectDistillationTarget/inventory.service.js"
    );

    const candidates = await collectVibeMemoryTargetCandidates();

    expect(mocks.limit).not.toHaveBeenCalled();
    expect(candidates.map((candidate) => candidate.targetKey)).toEqual([
      "memory-1",
      "memory-2",
      "memory-3",
    ]);
  });

  test("honors explicit vibe inventory limits", async () => {
    const { collectVibeMemoryTargetCandidates } = await import(
      "../src/modules/selectDistillationTarget/inventory.service.js"
    );

    const candidates = await collectVibeMemoryTargetCandidates({ limit: 2 });

    expect(mocks.limit).toHaveBeenCalledWith(2);
    expect(candidates.map((candidate) => candidate.targetKey)).toEqual(["memory-1", "memory-2"]);
  });
});
