import { beforeEach, describe, expect, test, vi } from "vitest";
import { db } from "../src/db/index.js";
import { auditLogs } from "../src/db/schema.js";
import {
  auditEventTypes,
  cleanupExpiredAuditLogs,
  cleanupExpiredAuditLogsSafe,
  listAuditLogs,
  recordAuditLog,
  recordAuditLogSafe,
  resetAuditLogStatus,
} from "../src/modules/audit/audit-log.service.js";

vi.mock("../src/db/index.js", () => ({
  db: {
    insert: vi.fn(),
    select: vi.fn(),
    selectDistinct: vi.fn(),
    delete: vi.fn(),
    execute: vi.fn(),
  },
}));

describe("audit-log service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAuditLogStatus();
  });

  describe("recordAuditLog", () => {
    test("inserts a record into the database", async () => {
      const mockValues = vi.fn().mockResolvedValue(undefined);
      (db.insert as any).mockReturnValue({ values: mockValues });

      const input = {
        eventType: "TEST_EVENT",
        actor: "user" as const,
        payload: { key: "value" },
      };

      await recordAuditLog(input);

      expect(db.insert).toHaveBeenCalledWith(auditLogs);
      expect(mockValues).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "TEST_EVENT",
          actor: "user",
          payload: { key: "value" },
        }),
      );
    });

    test("skips insert if eventType is empty", async () => {
      await recordAuditLog({ eventType: "  ", actor: "user" });
      expect(db.insert).not.toHaveBeenCalled();
    });

    test("redacts secrets from audit payloads", async () => {
      const mockValues = vi.fn().mockResolvedValue(undefined);
      (db.insert as any).mockReturnValue({ values: mockValues });

      await recordAuditLog({
        eventType: "TEST_EVENT",
        actor: "system",
        payload: {
          authToken: "raw-token-value",
          message: "Bearer abcdefghijklmnopqrstuvwxyz0123456789",
        },
      });

      const serialized = JSON.stringify(mockValues.mock.calls[0]?.[0]);
      expect(serialized).toContain("[REMOVED SENSITIVE DATA]");
      expect(serialized).not.toContain("raw-token-value");
      expect(serialized).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    });
  });

  describe("recordAuditLogSafe", () => {
    test("does not throw error even if database insert fails", async () => {
      (db.insert as any).mockImplementation(() => {
        throw new Error("DB Error");
      });

      await expect(
        recordAuditLogSafe({ eventType: "TEST", actor: "system" }),
      ).resolves.not.toThrow();
    });

    test("disables audit log if table availability check returns false on insert failure", async () => {
      (db.insert as any).mockImplementation(() => {
        throw new Error('insert into "audit_logs" failed');
      });
      (db.execute as any).mockResolvedValue({ rows: [{ regclass: null }] });

      await recordAuditLogSafe({ eventType: "TEST_FAIL", actor: "system" });

      expect(db.execute).toHaveBeenCalled();

      // Should be disabled now
      vi.clearAllMocks();
      await recordAuditLogSafe({ eventType: "TEST_RETRY", actor: "system" });
      expect(db.insert).not.toHaveBeenCalled();
    });

    test("handles errors in isAuditLogsTableAvailable", async () => {
      (db.insert as any).mockImplementation(() => {
        throw new Error('insert into "audit_logs" failed');
      });
      (db.execute as any).mockRejectedValue(new Error("Query failed"));

      await recordAuditLogSafe({ eventType: "TEST_FAIL", actor: "system" });

      // Should NOT be disabled because tableAvailable was null (error)
      vi.clearAllMocks();
      (db.insert as any).mockReturnValue({ values: vi.fn() });
      await recordAuditLogSafe({ eventType: "TEST_RETRY", actor: "system" });
      expect(db.insert).toHaveBeenCalled();
    });
  });

  describe("listAuditLogs", () => {
    test("returns paginated audit logs", async () => {
      const mockRows = [
        { id: "1", eventType: "TEST", actor: "user", payload: {}, createdAt: new Date() },
      ];
      const mockTotalRows = [{ count: "1" }];
      const mockDistinctRows = [{ eventType: "TEST" }];

      const mockDb = db as any;

      // Mock for total count
      const countChain = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue(mockTotalRows),
      };

      // Mock for rows
      const rowsChain = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        offset: vi.fn().mockResolvedValue(mockRows),
      };

      // Mock for distinct
      const distinctChain = {
        from: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockResolvedValue(mockDistinctRows),
      };

      mockDb.select.mockImplementation((arg: any) => {
        if (arg?.count) return countChain;
        return rowsChain;
      });
      mockDb.selectDistinct.mockReturnValue(distinctChain);

      const result = await listAuditLogs({ page: 1, limit: 10 });

      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.availableEventTypes).toContain("TEST");
    });
  });

  describe("cleanupExpiredAuditLogs", () => {
    test("deletes records older than retention period", async () => {
      const mockDeletedRows = [{ id: "old-1" }];
      (db.delete as any).mockReturnValue({
        where: vi.fn().mockReturnThis(),
        returning: vi.fn().mockResolvedValue(mockDeletedRows),
      });

      const result = await cleanupExpiredAuditLogs({ retentionDays: 7, trigger: "manual" });

      expect(db.delete).toHaveBeenCalledWith(auditLogs);
      expect(result.deletedCount).toBe(1);
      expect(result.trigger).toBe("manual");
    });
  });

  describe("cleanupExpiredAuditLogsSafe", () => {
    test("performs cleanup and records an audit log of the cleanup", async () => {
      const mockDeletedRows = [{ id: "old-1" }];
      (db.delete as any).mockReturnValue({
        where: vi.fn().mockReturnThis(),
        returning: vi.fn().mockResolvedValue(mockDeletedRows),
      });

      // Mock recordAuditLogSafe indirectly via db.insert
      const mockValues = vi.fn().mockResolvedValue(undefined);
      (db.insert as any).mockReturnValue({ values: mockValues });

      const result = await cleanupExpiredAuditLogsSafe({ retentionDays: 7 });

      expect(result?.deletedCount).toBe(1);
      expect(db.insert).toHaveBeenCalled();
    });

    test("returns null and logs warning on error", async () => {
      (db.delete as any).mockImplementation(() => {
        throw new Error("Delete failed");
      });

      const result = await cleanupExpiredAuditLogsSafe();
      expect(result).toBeNull();
    });
  });
});
