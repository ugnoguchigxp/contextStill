import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  getQueueControlStates,
  isQueuePaused,
  setQueuePaused,
} from "../src/modules/queue/core/control.js";

const mockFindSettingsRow = vi.fn();
const mockUpsertSettingsRow = vi.fn();

vi.mock("../src/modules/settings/settings.repository.js", () => ({
  findSettingsRow: (...args: any[]) => mockFindSettingsRow(...args),
  upsertSettingsRow: (...args: any[]) => mockUpsertSettingsRow(...args),
}));

describe("queue-control", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getQueueControlStates", () => {
    test("returns default states when settings row is not found", async () => {
      mockFindSettingsRow.mockResolvedValue(null);

      const states = await getQueueControlStates();

      expect(states.findingCandidate).toEqual({
        paused: false,
        updatedAt: null,
        updatedBy: null,
        reason: null,
      });
      expect(states.deadZoneMergeReview).toEqual({
        paused: false,
        updatedAt: null,
        updatedBy: null,
        reason: null,
      });
    });

    test("normalizes and merges stored states with defaults", async () => {
      mockFindSettingsRow.mockResolvedValue({
        value: {
          queues: {
            findingCandidate: {
              paused: true,
              updatedAt: "2026-06-10T12:00:00Z",
              updatedBy: "admin",
              reason: "Maintenence",
            },
            // other queues omitted to test defaults and normalization
            coveringEvidence: {
              paused: "not-a-boolean", // should resolve to false
              updatedAt: "  ", // should resolve to null
              updatedBy: 123, // should resolve to null
              reason: "", // should resolve to null
            },
          },
        },
      });

      const states = await getQueueControlStates();

      expect(states.findingCandidate).toEqual({
        paused: true,
        updatedAt: "2026-06-10T12:00:00Z",
        updatedBy: "admin",
        reason: "Maintenence",
      });

      expect(states.coveringEvidence).toEqual({
        paused: false,
        updatedAt: null,
        updatedBy: null,
        reason: null,
      });

      expect(states.deadZoneMergeReview).toEqual({
        paused: false,
        updatedAt: null,
        updatedBy: null,
        reason: null,
      });
    });
  });

  describe("isQueuePaused", () => {
    test("returns true if queue is paused, false otherwise", async () => {
      mockFindSettingsRow.mockResolvedValue({
        value: {
          queues: {
            findingCandidate: { paused: true },
            coveringEvidence: { paused: false },
          },
        },
      });

      expect(await isQueuePaused("findingCandidate")).toBe(true);
      expect(await isQueuePaused("coveringEvidence")).toBe(false);
    });
  });

  describe("setQueuePaused", () => {
    test("upserts new settings with updated pause state", async () => {
      mockFindSettingsRow.mockResolvedValue({
        schemaVersion: 2,
        value: {
          queues: {
            findingCandidate: { paused: false },
          },
        },
      });

      const result = await setQueuePaused({
        queueName: "findingCandidate",
        paused: true,
        reason: "Testing",
        updatedBy: "user-1",
      });

      expect(result.findingCandidate.paused).toBe(true);
      expect(result.findingCandidate.reason).toBe("Testing");
      expect(result.findingCandidate.updatedBy).toBe("user-1");
      expect(result.findingCandidate.updatedAt).not.toBeNull();

      expect(mockUpsertSettingsRow).toHaveBeenCalledWith(
        expect.objectContaining({
          namespace: "runtime",
          key: "queue.controls.v1",
          valueKind: "json",
          schemaVersion: 3,
          value: expect.objectContaining({
            queues: expect.objectContaining({
              findingCandidate: expect.objectContaining({
                paused: true,
                reason: "Testing",
                updatedBy: "user-1",
              }),
            }),
          }),
        }),
      );
    });

    test("handles optional parameters and falls back description correctly", async () => {
      mockFindSettingsRow.mockResolvedValue(null); // no existing row

      const result = await setQueuePaused({
        queueName: "deadZoneMergeReview",
        paused: true,
      });

      expect(result.deadZoneMergeReview.paused).toBe(true);
      expect(result.deadZoneMergeReview.reason).toBeNull();
      expect(result.deadZoneMergeReview.updatedBy).toBeNull();

      expect(mockUpsertSettingsRow).toHaveBeenCalledWith(
        expect.objectContaining({
          schemaVersion: 1,
          updatedBy: null,
        }),
      );
    });
  });
});
