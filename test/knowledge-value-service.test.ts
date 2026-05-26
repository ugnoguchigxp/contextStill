import { beforeEach, describe, expect, test, vi } from "vitest";
import { db } from "../src/db/index.js";
import { recordAuditLogSafe } from "../src/modules/audit/audit-log.service.js";
import {
  computeDecayFactor,
  computeDynamicScore,
  recordKnowledgeCompileSelection,
  recordKnowledgeCompileSelectionSafe,
} from "../src/modules/knowledge/knowledge-value.service.js";

vi.mock("../src/db/index.js", () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("../src/modules/audit/audit-log.service.js", () => ({
  recordAuditLogSafe: vi.fn().mockResolvedValue(undefined),
}));

describe("knowledge value service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("computeDynamicScore", () => {
    test("calculates score correctly with basic signals", () => {
      const score = computeDynamicScore({
        compileSelectCount: 10,
        recentSelectCount30d: 5,
        agenticAcceptCount: 2,
        explicitUpvoteCount: 1,
        explicitDownvoteCount: 0,
      });
      // Math.log1p(10)*10 (23.9) + 5*3 (15) + 2*4 (8) + 1*10 (10) - 0 = 56.9
      expect(score).toBeGreaterThan(50);
      expect(score).toBeLessThan(100);
    });

    test("clamps score between 0 and 100", () => {
      expect(
        computeDynamicScore({
          compileSelectCount: 1000,
          recentSelectCount30d: 100,
          agenticAcceptCount: 100,
          explicitUpvoteCount: 100,
          explicitDownvoteCount: 0,
        }),
      ).toBe(100);

      expect(
        computeDynamicScore({
          compileSelectCount: 0,
          recentSelectCount30d: 0,
          agenticAcceptCount: 0,
          explicitUpvoteCount: 0,
          explicitDownvoteCount: 100,
        }),
      ).toBe(0);
    });

    test("penalizes repeated not_used signals less than off_topic", () => {
      const baseline = computeDynamicScore({
        compileSelectCount: 6,
        recentSelectCount30d: 3,
        agenticAcceptCount: 1,
        explicitUpvoteCount: 0,
        explicitDownvoteCount: 0,
        usageUsedCount30d: 2,
      });
      const notUsedPenalty = computeDynamicScore({
        compileSelectCount: 6,
        recentSelectCount30d: 3,
        agenticAcceptCount: 1,
        explicitUpvoteCount: 0,
        explicitDownvoteCount: 0,
        usageUsedCount30d: 2,
        usageNotUsedCount30d: 8,
      });
      const offTopicPenalty = computeDynamicScore({
        compileSelectCount: 6,
        recentSelectCount30d: 3,
        agenticAcceptCount: 1,
        explicitUpvoteCount: 0,
        explicitDownvoteCount: 0,
        usageUsedCount30d: 2,
        usageOffTopicCount30d: 8,
      });

      expect(notUsedPenalty).toBeLessThan(baseline);
      expect(offTopicPenalty).toBeLessThan(notUsedPenalty);
    });
  });

  describe("computeDecayFactor", () => {
    test("calculates decay correctly", () => {
      const now = new Date("2026-06-01T00:00:00Z");
      const updatedAt = new Date("2026-05-01T00:00:00Z"); // 31 days ago

      const factor = computeDecayFactor({
        type: "rule",
        scope: "repo",
        lastVerifiedAt: null,
        updatedAt,
        now,
      });

      expect(factor).toBeLessThan(1);
      expect(factor).toBeGreaterThan(0.9); // lambda 0.001 * 31 = 0.031. e^-0.031 approx 0.969
    });
  });

  describe("recordKnowledgeCompileSelection", () => {
    test("updates DB counters for selected items", async () => {
      (db.select as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockResolvedValue([
            {
              id: "k1",
              compileSelectCount: 10,
              agenticAcceptCount: 5,
              explicitUpvoteCount: 1,
              explicitDownvoteCount: 0,
              lastVerifiedAt: null,
            },
          ]),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          groupBy: vi.fn().mockResolvedValue([{ itemId: "k1", count: 2 }]),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          groupBy: vi.fn().mockResolvedValue([]),
        });
      (db.update as any).mockReturnValue({
        set: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue(undefined),
      });

      await recordKnowledgeCompileSelection({
        runId: "r1",
        selectedKnowledgeIds: ["k1"],
        agenticAcceptedKnowledgeIds: ["k1"],
      });

      expect(db.update).toHaveBeenCalled();
    });
  });

  describe("recordKnowledgeCompileSelectionSafe", () => {
    test("logs audit event on error", async () => {
      (db.select as any).mockRejectedValue(new Error("DB Error"));

      await recordKnowledgeCompileSelectionSafe({
        runId: "r1",
        selectedKnowledgeIds: ["k1"],
        agenticAcceptedKnowledgeIds: [],
      });

      expect(recordAuditLogSafe).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "KNOWLEDGE_VALUE_UPDATE_FAILED",
        }),
      );
    });
  });
});
