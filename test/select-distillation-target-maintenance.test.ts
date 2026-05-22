import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../src/db/index.js";
import { recordAuditLogSafe } from "../src/modules/audit/audit-log.service.js";
import {
  releaseRetryablePausedDistillationTargets,
  recoverStaleDistillationTargets,
  markMissingWikiTargetsSkipped,
  getDistillationTargetSummary,
} from "../src/modules/selectDistillationTarget/repository-maintenance.js";

const mockSelect = vi.fn();
const mockUpdate = vi.fn();

vi.mock("../src/db/index.js", () => ({
  db: {
    select: (...args: any[]) => mockSelect(...args),
    update: (...args: any[]) => mockUpdate(...args),
  },
}));

vi.mock("../src/modules/audit/audit-log.service.js", () => ({
  auditEventTypes: {
    distillationTargetRecovered: "DISTILLATION_TARGET_RECOVERED",
  },
  recordAuditLogSafe: vi.fn().mockResolvedValue(undefined),
}));

const makeChain = (result: any) => {
  const chain = {
    from: vi.fn().mockImplementation(() => chain),
    where: vi.fn().mockImplementation(() => chain),
    limit: vi.fn().mockImplementation(() => chain),
    orderBy: vi.fn().mockImplementation(() => chain),
    groupBy: vi.fn().mockImplementation(() => chain),
    set: vi.fn().mockImplementation(() => chain),
    returning: vi.fn().mockResolvedValue(result),
    then: (onfulfilled: any) => Promise.resolve(result).then(onfulfilled),
    catch: (onrejected: any) => Promise.resolve(result).catch(onrejected),
  };
  return chain;
};

describe("selectDistillationTarget repository-maintenance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("releaseRetryablePausedDistillationTargets", () => {
    it("updates target status from paused to pending", async () => {
      const mockRows = [{ id: "target-1" }];
      mockUpdate.mockReturnValueOnce(makeChain(mockRows));

      const count = await releaseRetryablePausedDistillationTargets({
        distillationVersion: "v1",
        now: new Date(),
      });

      expect(count).toBe(1);
      expect(mockUpdate).toHaveBeenCalled();
    });
  });

  describe("recoverStaleDistillationTargets", () => {
    it("does nothing if there are no running targets", async () => {
      mockSelect.mockReturnValueOnce(makeChain([])); // No running targets

      const result = await recoverStaleDistillationTargets();
      expect(result).toEqual({ recoveredToPending: 0, failed: 0, skipped: 0 });
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it("recovers stale targets to pending if attemptCount is under limit", async () => {
      const now = new Date();
      // heartbeat is older than threshold
      const staleHeartbeat = new Date(now.getTime() - 600 * 1000);
      const mockRunning = [
        {
          id: "t-1",
          status: "running",
          attemptCount: 1,
          heartbeatAt: staleHeartbeat,
          lockedAt: staleHeartbeat,
        },
      ];

      // 1. load running targets
      mockSelect.mockReturnValueOnce(makeChain(mockRunning));
      // 2. update call in loop
      mockUpdate.mockReturnValueOnce(makeChain([{ id: "t-1" }]));

      const result = await recoverStaleDistillationTargets({
        now,
        maxAttempts: 3,
        staleSeconds: 300,
      });

      expect(result.recoveredToPending).toBe(1);
      expect(result.skipped).toBe(0);
      expect(mockUpdate).toHaveBeenCalled();
      expect(recordAuditLogSafe).toHaveBeenCalled();
    });

    it("skips stale targets if attemptCount exceeds limit", async () => {
      const now = new Date();
      const staleHeartbeat = new Date(now.getTime() - 600 * 1000);
      const mockRunning = [
        {
          id: "t-1",
          status: "running",
          attemptCount: 5, // Limit is 3
          heartbeatAt: staleHeartbeat,
          lockedAt: staleHeartbeat,
        },
      ];

      mockSelect.mockReturnValueOnce(makeChain(mockRunning));
      mockUpdate.mockReturnValueOnce(makeChain([{ id: "t-1" }]));

      const result = await recoverStaleDistillationTargets({
        now,
        maxAttempts: 3,
        staleSeconds: 300,
      });

      expect(result.recoveredToPending).toBe(0);
      expect(result.skipped).toBe(1);
      expect(mockUpdate).toHaveBeenCalled();
    });
  });

  describe("markMissingWikiTargetsSkipped", () => {
    it("skips missing wiki files", async () => {
      const mockWikiRows = [
        { id: "wiki-1", targetKey: "missing.md" },
        { id: "wiki-2", targetKey: "existing.md" },
      ];
      // 1. select wiki target states
      mockSelect.mockReturnValueOnce(makeChain(mockWikiRows));
      // 2. update for missing
      mockUpdate.mockReturnValueOnce(makeChain([{ id: "wiki-1" }]));

      const currentKeys = new Set(["existing.md"]);
      const updatedCount = await markMissingWikiTargetsSkipped({
        currentTargetKeys: currentKeys,
        rootPath: "/workspace",
      });

      expect(updatedCount).toBe(1);
      expect(mockUpdate).toHaveBeenCalled();
    });
  });

  describe("getDistillationTargetSummary", () => {
    it("returns correctly aggregated statistics", async () => {
      const mockSummaryRows = [
        { targetKind: "knowledge_candidate", status: "pending", value: 3 },
        { targetKind: "wiki_file", status: "pending", value: 2 },
        { targetKind: "vibe_memory", status: "completed", value: 5 },
      ];
      // 1. group by query
      mockSelect.mockReturnValueOnce(makeChain(mockSummaryRows));
      // 2. countStaleRunning query -> returns empty running rows
      mockSelect.mockReturnValueOnce(makeChain([]));
      // 3. lastCompleted
      mockSelect.mockReturnValueOnce(makeChain([{ id: "last-completed" }]));
      // 4. lastSkipped
      mockSelect.mockReturnValueOnce(makeChain([]));
      // 5. lastFailed
      mockSelect.mockReturnValueOnce(makeChain([]));

      const result = await getDistillationTargetSummary({ distillationVersion: "0.1.0" });
      expect(result.version).toBe("0.1.0");
      expect(result.pendingKnowledgeCandidates).toBe(3);
      expect(result.pendingWiki).toBe(2);
      expect(result.queued).toBe(5);
    });
  });
});
