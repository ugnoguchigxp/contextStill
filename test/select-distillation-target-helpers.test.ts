import { describe, expect, it } from "vitest";
import {
  leaseFromTargetState,
  nowMinusSeconds,
  rowHeartbeatMs,
  staleThresholdMs,
} from "../src/modules/selectDistillationTarget/repository-helpers.js";

describe("selectDistillationTarget repository helpers", () => {
  describe("nowMinusSeconds", () => {
    it("subtracts correct amount of seconds", () => {
      const now = new Date("2026-05-22T12:00:00.000Z");
      const past = nowMinusSeconds(30, now);
      expect(past.toISOString()).toBe("2026-05-22T11:59:30.000Z");
    });

    it("uses at least 1 second subtraction even if 0 or negative is passed", () => {
      const now = new Date("2026-05-22T12:00:00.000Z");
      const past = nowMinusSeconds(-10, now);
      expect(past.toISOString()).toBe("2026-05-22T11:59:59.000Z");
    });
  });

  describe("staleThresholdMs", () => {
    it("returns correct millisecond timestamp", () => {
      const now = new Date("2026-05-22T12:00:00.000Z");
      const threshold = staleThresholdMs(10, now);
      expect(threshold).toBe(now.getTime() - 10000);
    });
  });

  describe("rowHeartbeatMs", () => {
    it("prefers heartbeatAt if present", () => {
      const row = {
        heartbeatAt: new Date("2026-05-22T12:00:10.000Z"),
        lockedAt: new Date("2026-05-22T12:00:00.000Z"),
      };
      expect(rowHeartbeatMs(row)).toBe(row.heartbeatAt.getTime());
    });

    it("falls back to lockedAt if heartbeatAt is null", () => {
      const row = {
        heartbeatAt: null,
        lockedAt: new Date("2026-05-22T12:00:00.000Z"),
      };
      expect(rowHeartbeatMs(row)).toBe(row.lockedAt.getTime());
    });

    it("returns negative infinity if both are null", () => {
      const row = {
        heartbeatAt: null,
        lockedAt: null,
      };
      expect(rowHeartbeatMs(row)).toBe(Number.NEGATIVE_INFINITY);
    });
  });

  describe("leaseFromTargetState", () => {
    it("extracts correct lease properties", () => {
      const row = {
        id: "target-123",
        targetKind: "wiki_file" as const,
        targetKey: "key.md",
        sourceUri: "uri",
        distillationVersion: "v1",
        status: "running" as const,
        phase: "selected" as const,
        priorityGroup: "wiki" as const,
        sortKey: "key",
        lockedBy: "worker-xyz",
        lockedAt: new Date(),
        heartbeatAt: new Date(),
        nextRetryAt: null,
        attemptCount: 3,
        lastOutcomeKind: null,
        lastError: null,
        candidateCount: 0,
        knowledgeIds: null,
        metadata: {},
        completedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const lease = leaseFromTargetState(row);
      expect(lease).toEqual({
        targetStateId: "target-123",
        lockedBy: "worker-xyz",
        attemptCount: 3,
      });
    });

    it("handles null lockedBy gracefully", () => {
      const row = {
        id: "target-123",
        targetKind: "wiki_file" as const,
        targetKey: "key.md",
        sourceUri: "uri",
        distillationVersion: "v1",
        status: "running" as const,
        phase: "selected" as const,
        priorityGroup: "wiki" as const,
        sortKey: "key",
        lockedBy: null,
        lockedAt: null,
        heartbeatAt: null,
        nextRetryAt: null,
        attemptCount: 1,
        lastOutcomeKind: null,
        lastError: null,
        candidateCount: 0,
        knowledgeIds: null,
        metadata: {},
        completedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const lease = leaseFromTargetState(row);
      expect(lease.lockedBy).toBe("");
    });
  });
});
