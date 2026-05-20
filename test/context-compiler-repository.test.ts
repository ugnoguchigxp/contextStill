import { beforeEach, describe, expect, test, vi } from "vitest";
import { db } from "../src/db/index.js";
import { contextCompileRuns, contextPackItems } from "../src/db/schema.js";
import {
  getCompileFreshnessMarkers,
  getCompileRunDetail,
  getCompileRunSnapshot,
  insertCompileRun,
  insertContextPackItems,
  listRecentCompileRuns,
  updateCompileRunSnapshot,
} from "../src/modules/context-compiler/context-compiler.repository.js";
import type { ContextPack } from "../src/shared/schemas/context-pack.schema.js";

vi.mock("../src/db/index.js", () => ({
  db: {
    insert: vi.fn(),
    select: vi.fn(),
    update: vi.fn(),
    execute: vi.fn(),
  },
}));

const validPack: ContextPack = {
  runId: "550e8400-e29b-41d4-a716-446655440000",
  goal: "detail goal",
  intent: "edit",
  retrievalMode: "task_context",
  status: "ok",
  minimalTasks: ["Inspect context"],
  rules: [],
  procedures: [],
  codeContext: [],
  warnings: [],
  sourceRefs: ["memory-router://packs/run/550e8400-e29b-41d4-a716-446655440000#full"],
  diagnostics: {
    degradedReasons: [],
    retrievalStats: { tokenBudget: 5000 },
  },
};

describe("context-compiler repository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("insertCompileRun", () => {
    test("inserts a compile run and returns the ID", async () => {
      const mockInserted = [{ id: "run-123" }];
      const mockValues = vi.fn().mockReturnThis();
      (db.insert as any).mockReturnValue({
        values: mockValues,
        returning: vi.fn().mockResolvedValue(mockInserted),
      });

      const params = {
        goal: "test goal",
        intent: "plan",
        input: { foo: "bar" },
        retrievalMode: "task_context",
        status: "ok" as const,
        degradedReasons: [],
        tokenBudget: 1000,
        durationMs: 500,
        source: "mcp" as const,
      };

      const result = await insertCompileRun(params);

      expect(db.insert).toHaveBeenCalledWith(contextCompileRuns);
      expect(mockValues).toHaveBeenCalledWith(expect.objectContaining({ source: "mcp" }));
      expect(result).toBe("run-123");
    });
  });

  describe("updateCompileRunSnapshot", () => {
    test("updates the persisted pack snapshot", async () => {
      const mockWhere = vi.fn().mockResolvedValue(undefined);
      const mockSet = vi.fn().mockReturnValue({ where: mockWhere });
      (db.update as any).mockReturnValue({ set: mockSet });

      await updateCompileRunSnapshot(validPack.runId, validPack);

      expect(db.update).toHaveBeenCalledWith(contextCompileRuns);
      expect(mockSet).toHaveBeenCalledWith({ packSnapshot: validPack });
      expect(mockWhere).toHaveBeenCalled();
    });
  });

  describe("insertContextPackItems", () => {
    test("inserts items if array is not empty", async () => {
      const mockValues = vi.fn().mockResolvedValue(undefined);
      (db.insert as any).mockReturnValue({ values: mockValues });

      await insertContextPackItems("run-1", [
        {
          itemKind: "rule",
          itemId: "r1",
          section: "rules",
          score: 100,
          rankingReason: "test",
          sourceRefs: [],
        },
      ]);

      expect(db.insert).toHaveBeenCalledWith(contextPackItems);
      expect(mockValues).toHaveBeenCalled();
    });

    test("does nothing if array is empty", async () => {
      await insertContextPackItems("run-1", []);
      expect(db.insert).not.toHaveBeenCalled();
    });
  });

  describe("listRecentCompileRuns", () => {
    test("returns formatted summaries", async () => {
      const mockRows = [
        {
          id: "r1",
          goal: "g1",
          intent: "i1",
          retrievalMode: "m1",
          status: "ok",
          degradedReasons: [],
          durationMs: 123.45,
          source: "ui",
          createdAt: new Date(),
        },
      ];

      (db.select as any).mockReturnValue({
        from: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue(mockRows),
      });

      const result = await listRecentCompileRuns(1);

      expect(result).toHaveLength(1);
      expect(result[0].durationMs).toBe(123); // Rounded
      expect(result[0].source).toBe("ui");
    });

    test("handles missing input or diagnostics gracefully", async () => {
      const mockRows = [
        {
          id: "r1",
          goal: "g1",
          intent: "i1",
          input: null,
          retrievalMode: "m1",
          status: "ok",
          degradedReasons: null,
          durationMs: null,
          source: "unexpected",
          createdAt: new Date(),
        },
      ];

      (db.select as any).mockReturnValue({
        from: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue(mockRows),
      });

      const result = await listRecentCompileRuns(1);
      expect(result[0].degradedReasons).toEqual([]);
      expect(result[0].durationMs).toBe(0);
      expect(result[0].source).toBe("unknown");
    });
  });

  describe("getCompileRunSnapshot", () => {
    test("returns null if run not found", async () => {
      (db.select as any).mockReturnValue({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([]),
      });

      const result = await getCompileRunSnapshot("missing");
      expect(result).toBeNull();
    });

    test("returns run and items if found", async () => {
      const mockRun = {
        id: "r1",
        goal: "g",
        intent: "i",
        retrievalMode: "task_context",
        status: "ok",
        degradedReasons: [],
        durationMs: 100,
        source: "mcp",
        createdAt: new Date(),
      };
      const mockItems = [
        {
          itemKind: "rule",
          itemId: "i1",
          section: "rules",
          score: 100,
          rankingReason: "r",
          sourceRefs: ["s1"],
        },
      ];

      (db.select as any).mockReturnValueOnce({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([mockRun]),
      });

      (db.select as any).mockReturnValueOnce({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockResolvedValue(mockItems),
      });

      const result = await getCompileRunSnapshot("r1");

      expect(result?.run.id).toBe("r1");
      expect(result?.run.source).toBe("mcp");
      expect(result?.items).toHaveLength(1);
    });
  });

  describe("getCompileRunDetail", () => {
    test("returns null if run not found", async () => {
      (db.select as any).mockReturnValue({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([]),
      });

      const result = await getCompileRunDetail(validPack.runId);
      expect(result).toBeNull();
    });

    test("returns detail with valid pack snapshot", async () => {
      const mockRun = {
        id: validPack.runId,
        goal: validPack.goal,
        intent: validPack.intent,
        retrievalMode: validPack.retrievalMode,
        status: validPack.status,
        degradedReasons: [],
        durationMs: 100,
        source: "cli",
        createdAt: new Date("2026-05-15T00:00:00.000Z"),
        tokenBudget: 5000,
        input: { goal: validPack.goal, intent: validPack.intent },
        packSnapshot: validPack,
      };
      const mockItems = [
        {
          itemKind: "rule",
          itemId: "i1",
          section: "rules",
          score: 100,
          rankingReason: "r",
          sourceRefs: ["s1"],
        },
      ];

      (db.select as any).mockReturnValueOnce({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([mockRun]),
      });

      (db.select as any).mockReturnValueOnce({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockResolvedValue(mockItems),
      });

      const result = await getCompileRunDetail(validPack.runId);

      expect(result?.snapshotAvailable).toBe(true);
      expect(result?.pack?.runId).toBe(validPack.runId);
      expect(result?.run.source).toBe("cli");
      expect(result?.selectedItems).toHaveLength(1);
    });

    test("returns legacy detail when pack snapshot is unavailable", async () => {
      const mockRun = {
        id: validPack.runId,
        goal: validPack.goal,
        intent: validPack.intent,
        retrievalMode: validPack.retrievalMode,
        status: validPack.status,
        degradedReasons: [],
        durationMs: 100,
        source: "unknown",
        createdAt: new Date("2026-05-15T00:00:00.000Z"),
        tokenBudget: 5000,
        input: { goal: validPack.goal, lastErrorContext: {}, retrievalMode: "legacy_mode" },
        packSnapshot: null,
      };

      (db.select as any).mockReturnValueOnce({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([mockRun]),
      });

      (db.select as any).mockReturnValueOnce({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockResolvedValue([]),
      });

      const result = await getCompileRunDetail(validPack.runId);

      expect(result?.snapshotAvailable).toBe(false);
      expect(result?.pack).toBeNull();
      expect(result?.run.input).toEqual(mockRun.input);
      expect(result?.selectedItems).toEqual([]);
    });

    test("does not expose a pack snapshot from a different run", async () => {
      const mockRun = {
        id: validPack.runId,
        goal: validPack.goal,
        intent: validPack.intent,
        retrievalMode: validPack.retrievalMode,
        status: validPack.status,
        degradedReasons: [],
        durationMs: 100,
        source: "ui",
        createdAt: new Date("2026-05-15T00:00:00.000Z"),
        tokenBudget: 5000,
        input: { goal: validPack.goal, intent: validPack.intent },
        packSnapshot: {
          ...validPack,
          runId: "550e8400-e29b-41d4-a716-446655440001",
        },
      };

      (db.select as any).mockReturnValueOnce({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([mockRun]),
      });

      (db.select as any).mockReturnValueOnce({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockResolvedValue([]),
      });

      const result = await getCompileRunDetail(validPack.runId);

      expect(result?.snapshotAvailable).toBe(false);
      expect(result?.pack).toBeNull();
      expect(result?.selectedItems).toEqual([]);
    });
  });

  describe("getCompileFreshnessMarkers", () => {
    test("returns timestamps as ISO strings", async () => {
      const now = new Date();
      (db.execute as any).mockResolvedValueOnce({
        rows: [{ active_updated_at: now, draft_updated_at: now.toISOString() }],
      });
      (db.execute as any).mockResolvedValueOnce({
        rows: [{ source_updated_at: "2026-05-15T00:00:00Z" }],
      });

      const result = await getCompileFreshnessMarkers();

      expect(result.knowledgeActiveUpdatedAt).toBe(now.toISOString());
      expect(result.knowledgeDraftUpdatedAt).toBe(now.toISOString());
      expect(result.sourceCorpusUpdatedAt).toBe("2026-05-15T00:00:00.000Z");
    });

    test("handles null or invalid timestamps", async () => {
      (db.execute as any).mockResolvedValueOnce({
        rows: [{ active_updated_at: null, draft_updated_at: "invalid" }],
      });
      (db.execute as any).mockResolvedValueOnce({
        rows: [{ source_updated_at: undefined }],
      });

      const result = await getCompileFreshnessMarkers();

      expect(result.knowledgeActiveUpdatedAt).toBeNull();
      expect(result.knowledgeDraftUpdatedAt).toBeNull();
      expect(result.sourceCorpusUpdatedAt).toBeNull();
    });
  });
});
