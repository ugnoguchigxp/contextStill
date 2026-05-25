import { beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import { db } from "../src/db/index.js";
import { recordAuditLogSafe } from "../src/modules/audit/audit-log.service.js";
import {
  releaseRetryablePausedDistillationTargets,
  recoverOrphanedRunningDistillationTargets,
  recoverStaleDistillationTargets,
  markMissingVibeMemoryTargetsSkipped,
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
      mockUpdate.mockReturnValueOnce(makeChain([])).mockReturnValueOnce(makeChain(mockRows));

      const count = await releaseRetryablePausedDistillationTargets({
        distillationVersion: "v1",
        now: new Date(),
      });

      expect(count).toBe(1);
      expect(mockSelect).not.toHaveBeenCalled();
      expect(mockUpdate).toHaveBeenCalled();
    });

    it("skips paused targets that already reached the retry limit", async () => {
      mockUpdate
        .mockReturnValueOnce(makeChain([{ id: "target-1" }]))
        .mockReturnValueOnce(makeChain([]));

      const count = await releaseRetryablePausedDistillationTargets({
        distillationVersion: "v1",
        now: new Date(),
      });

      expect(count).toBe(0);
      expect(mockSelect).not.toHaveBeenCalled();
      expect(mockUpdate).toHaveBeenCalledTimes(2);
    });

    it("skips retry-exhausted paused targets even before their next retry time", async () => {
      mockSelect.mockReturnValueOnce(
        makeChain([
          {
            id: "future-exhausted",
            attemptCount: 2,
            nextRetryAt: new Date(Date.now() + 60_000),
            lastError: "cover_evidence_retryable",
            metadata: {},
          },
        ]),
      );
      mockUpdate.mockReturnValueOnce(makeChain([{ id: "future-exhausted" }]));

      const count = await releaseRetryablePausedDistillationTargets({
        distillationVersion: "v1",
        now: new Date(),
        excludeManualPauseReasons: true,
      });

      expect(count).toBe(0);
      expect(mockUpdate).toHaveBeenCalledTimes(1);
    });

    it("does not release manual paused targets when excludeManualPauseReasons is enabled", async () => {
      mockSelect.mockReturnValueOnce(
        makeChain([
          { id: "manual", attemptCount: 1, lastError: "manual_pause", metadata: {} },
          {
            id: "retryable",
            attemptCount: 1,
            lastError: "cover_evidence_retryable",
            metadata: {},
          },
        ]),
      );
      mockUpdate.mockReturnValueOnce(makeChain([{ id: "retryable" }]));

      const count = await releaseRetryablePausedDistillationTargets({
        distillationVersion: "v1",
        now: new Date(),
        excludeManualPauseReasons: true,
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

  describe("recoverOrphanedRunningDistillationTargets", () => {
    it("recovers running targets owned by a dead local worker pid", async () => {
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
        const error = new Error("missing process");
        (error as { code?: string }).code = "ESRCH";
        throw error;
      });
      mockSelect.mockReturnValueOnce(
        makeChain([
          {
            id: "orphaned-1",
            status: "running",
            attemptCount: 1,
            lockedBy: `${os.hostname()}:12345`,
          },
        ]),
      );
      mockUpdate.mockReturnValueOnce(makeChain([{ id: "orphaned-1" }]));

      try {
        const result = await recoverOrphanedRunningDistillationTargets({
          distillationVersion: "v1",
          maxAttempts: 3,
        });

        expect(result).toEqual({ recoveredToPending: 1, failed: 0, skipped: 0 });
        expect(mockUpdate).toHaveBeenCalled();
        expect(recordAuditLogSafe).toHaveBeenCalledWith(
          expect.objectContaining({
            payload: expect.objectContaining({ reason: "dead_local_worker" }),
          }),
        );
      } finally {
        killSpy.mockRestore();
      }
    });

    it("leaves running targets alone when the local worker pid is still alive", async () => {
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
      mockSelect.mockReturnValueOnce(
        makeChain([
          {
            id: "active-1",
            status: "running",
            attemptCount: 1,
            lockedBy: `${os.hostname()}:12345`,
          },
        ]),
      );

      try {
        const result = await recoverOrphanedRunningDistillationTargets({
          distillationVersion: "v1",
        });

        expect(result).toEqual({ recoveredToPending: 0, failed: 0, skipped: 0 });
        expect(mockUpdate).not.toHaveBeenCalled();
      } finally {
        killSpy.mockRestore();
      }
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

  describe("markMissingVibeMemoryTargetsSkipped", () => {
    it("skips missing vibe memory targets", async () => {
      const mockVibeRows = [
        { id: "vibe-1", targetKey: "missing-memory" },
        { id: "vibe-2", targetKey: "existing-memory" },
      ];
      mockSelect.mockReturnValueOnce(makeChain(mockVibeRows));
      mockUpdate.mockReturnValueOnce(makeChain([{ id: "vibe-1" }]));

      const updatedCount = await markMissingVibeMemoryTargetsSkipped({
        currentTargetKeys: new Set(["existing-memory"]),
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
