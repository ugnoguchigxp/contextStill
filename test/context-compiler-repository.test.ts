import { beforeEach, describe, expect, test, vi } from "vitest";
import { db } from "../src/db/index.js";
import { contextCompileRuns, contextPackItems } from "../src/db/schema.js";
import {
  getCompileFreshnessMarkers,
  getCompileRunSnapshot,
  insertCompileRun,
  insertContextPackItems,
  listRecentCompileRuns,
} from "../src/modules/context-compiler/context-compiler.repository.js";

vi.mock("../src/db/index.js", () => ({
  db: {
    insert: vi.fn(),
    select: vi.fn(),
    execute: vi.fn(),
  },
}));

describe("context-compiler repository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("insertCompileRun", () => {
    test("inserts a compile run and returns the ID", async () => {
      const mockInserted = [{ id: "run-123" }];
      (db.insert as any).mockReturnValue({
        values: vi.fn().mockReturnThis(),
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
      };

      const result = await insertCompileRun(params);

      expect(db.insert).toHaveBeenCalledWith(contextCompileRuns);
      expect(result).toBe("run-123");
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
    test("returns formatted summaries including cache key from diagnostics", async () => {
      const mockRows = [
        {
          id: "r1",
          goal: "g1",
          intent: "i1",
          input: { _compileDiagnostics: { cacheKeyDraft: "hash-123" } },
          retrievalMode: "m1",
          status: "ok",
          degradedReasons: [],
          durationMs: 123.45,
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
      expect(result[0].cacheKeyDraft).toBe("hash-123");
      expect(result[0].durationMs).toBe(123); // Rounded
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
          createdAt: new Date(),
        },
      ];

      (db.select as any).mockReturnValue({
        from: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue(mockRows),
      });

      const result = await listRecentCompileRuns(1);
      expect(result[0].cacheKeyDraft).toBeNull();
      expect(result[0].degradedReasons).toEqual([]);
      expect(result[0].durationMs).toBe(0);
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
        retrievalMode: "m",
        status: "ok",
        degradedReasons: [],
        durationMs: 100,
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
      expect(result?.items).toHaveLength(1);
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
