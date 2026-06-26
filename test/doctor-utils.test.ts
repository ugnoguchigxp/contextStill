import { describe, expect, test, vi } from "vitest";
import {
  cursorFileCount,
  metadataSkipped,
  metadataWarnings,
  minutesSince,
  normalizeReasonCounts,
  nowIso,
  timestampToIso,
} from "../src/modules/doctor/doctor.utils.js";

describe("Doctor Utils", () => {
  test("nowIso returns a valid ISO string", () => {
    const iso = nowIso();
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  test("minutesSince calculates correct minutes elapsed", () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const tenMinutesAgo = new Date(now - 10 * 60 * 1000).toISOString();
    expect(minutesSince(tenMinutesAgo)).toBeCloseTo(10, 2);

    // returns 0 for future dates
    const futureDate = new Date(now + 10 * 60 * 1000).toISOString();
    expect(minutesSince(futureDate)).toBe(0);

    vi.restoreAllMocks();
  });

  test("timestampToIso treats database timestamps without timezone as UTC", () => {
    expect(timestampToIso("2026-06-26 06:37:58")).toBe("2026-06-26T06:37:58.000Z");
    expect(timestampToIso("2026-06-26T06:37:58.123")).toBe("2026-06-26T06:37:58.123Z");
  });

  describe("cursorFileCount", () => {
    test("returns number of keys for objects", () => {
      expect(cursorFileCount({ a: 1, b: 2 })).toBe(2);
      expect(cursorFileCount({})).toBe(0);
    });

    test("returns 0 for invalid inputs", () => {
      expect(cursorFileCount(null)).toBe(0);
      expect(cursorFileCount(undefined)).toBe(0);
      expect(cursorFileCount([1, 2, 3])).toBe(0);
      expect(cursorFileCount("string")).toBe(0);
      expect(cursorFileCount(123)).toBe(0);
    });
  });

  describe("metadataWarnings", () => {
    test("extracts warning strings successfully", () => {
      expect(metadataWarnings({ warnings: ["warn1", "warn2"] })).toEqual(["warn1", "warn2"]);
    });

    test("filters out non-string values", () => {
      expect(metadataWarnings({ warnings: ["warn1", 123, null, "warn2"] })).toEqual([
        "warn1",
        "warn2",
      ]);
    });

    test("returns empty array for invalid formats", () => {
      expect(metadataWarnings({ warnings: "not-an-array" })).toEqual([]);
      expect(metadataWarnings({})).toEqual([]);
      expect(metadataWarnings(null)).toEqual([]);
      expect(metadataWarnings([1, 2])).toEqual([]);
    });
  });

  describe("metadataSkipped", () => {
    test("extracts skipped status", () => {
      expect(metadataSkipped({ skipped: true })).toBe(true);
      expect(metadataSkipped({ skipped: false })).toBe(false);
      expect(metadataSkipped({ skipped: 1 })).toBe(true);
    });

    test("returns false for invalid inputs", () => {
      expect(metadataSkipped({})).toBe(false);
      expect(metadataSkipped(null)).toBe(false);
      expect(metadataSkipped("skipped")).toBe(false);
    });
  });

  describe("normalizeReasonCounts", () => {
    test("normalizes valid items", () => {
      const input = [
        { reason: "A", count: 5.5 },
        { reason: " B ", count: "10" },
      ];
      const output = normalizeReasonCounts(input);
      expect(output).toEqual([
        { reason: "A", count: 5 },
        { reason: " B ", count: 10 },
      ]);
    });

    test("filters out invalid items", () => {
      const input = [
        null,
        [1, 2],
        "string",
        { reason: "", count: 5 }, // empty reason
        { reason: "A", count: -1 }, // negative count
        { reason: "B", count: Number.NaN }, // invalid number
        { reason: "C", count: Number.POSITIVE_INFINITY }, // infinite number
        { count: 5 }, // missing reason
      ];
      expect(normalizeReasonCounts(input)).toEqual([]);
      expect(normalizeReasonCounts("not-an-array")).toEqual([]);
    });
  });
});
