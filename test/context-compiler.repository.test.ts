import { beforeEach, describe, expect, test, vi } from "vitest";
import { db } from "../src/db/index.js";
import {
  getCompileRunSnapshot,
  insertCompileRun,
  insertContextPackItems,
  listRecentCompileRuns,
} from "../src/modules/context-compiler/context-compiler.repository.js";

vi.mock("../src/db/index.js", () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(),
      })),
    })),
    select: vi.fn(() => {
      const chain = {
        from: vi.fn(),
        where: vi.fn(),
        orderBy: vi.fn(),
        limit: vi.fn(),
      };
      chain.from.mockReturnValue(chain);
      chain.where.mockReturnValue(chain);
      chain.orderBy.mockReturnValue(chain);
      return chain;
    }),
  },
}));

describe("Context Compiler Repository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("insertCompileRun inserts and returns id", async () => {
    const mockReturning = vi.fn().mockResolvedValue([{ id: "run-1" }]);
    const mockValues = vi.fn(() => ({ returning: mockReturning }));
    vi.mocked(db.insert).mockReturnValue({ values: mockValues } as any);

    const id = await insertCompileRun({
      goal: "test",
      intent: "edit",
      input: {},
      retrievalMode: "learning",
      status: "ok",
      degradedReasons: [],
      tokenBudget: 1000,
      durationMs: 50,
    });

    expect(id).toBe("run-1");
    expect(db.insert).toHaveBeenCalled();
  });

  test("insertContextPackItems inserts multiple items", async () => {
    const mockValues = vi.fn();
    vi.mocked(db.insert).mockReturnValue({ values: mockValues } as any);

    await insertContextPackItems("run-1", [
      {
        itemKind: "rule",
        itemId: "id1",
        section: "rules",
        score: 1,
        rankingReason: "r",
        sourceRefs: [],
      },
    ]);
    expect(mockValues).toHaveBeenCalled();
  });

  test("getCompileRunSnapshot returns full snapshot", async () => {
    const mockRunLimit = vi.fn().mockResolvedValue([
      {
        id: "r1",
        goal: "g1",
        intent: "i1",
        retrievalMode: "m1",
        status: "ok",
        degradedReasons: [],
        createdAt: new Date(),
      },
    ]);
    const mockRunWhere = vi.fn(() => ({ limit: mockRunLimit }));
    const mockRunFrom = vi.fn(() => ({ where: mockRunWhere }));

    const mockItemOrderBy = vi.fn().mockResolvedValue([
      {
        itemKind: "k1",
        itemId: "id1",
        section: "s1",
        score: 0.9,
        rankingReason: "rr",
        sourceRefs: ["ref1"],
      },
    ]);
    const mockItemWhere = vi.fn(() => ({ orderBy: mockItemOrderBy }));
    const mockItemFrom = vi.fn(() => ({ where: mockItemWhere }));

    vi.mocked(db.select)
      .mockReturnValueOnce({ from: mockRunFrom } as any)
      .mockReturnValueOnce({ from: mockItemFrom } as any);

    const result = await getCompileRunSnapshot("r1");
    expect(result).not.toBeNull();
    expect(result?.run.id).toBe("r1");
    expect(result?.items).toHaveLength(1);
    expect(result?.items[0].itemId).toBe("id1");
  });
});
