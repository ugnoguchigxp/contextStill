import { describe, expect, test } from "vitest";
import {
  asRecord,
  asStringArray,
  normalizeFacetArray,
  normalizeNullableString,
  normalizeStringArray,
  toIsoString,
} from "../src/shared/utils/normalize.js";

describe("normalize utils", () => {
  test("asRecord", () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    expect(asRecord(null)).toEqual({});
    expect(asRecord("string")).toEqual({});
    expect(asRecord([1, 2])).toEqual({});
  });

  test("asStringArray", () => {
    expect(asStringArray(["a ", " b", 1, null])).toEqual(["a", "b"]);
    expect(asStringArray("not-array")).toEqual([]);
  });

  test("normalizeStringArray", () => {
    expect(
      normalizeStringArray(["B", "a", "A", "b"], {
        lowercase: true,
        sort: true,
        dedupeCaseInsensitive: true,
      }),
    ).toEqual(["a", "b"]);

    expect(
      normalizeStringArray(["B", "a", "A", "b"], {
        lowercase: false,
        sort: false,
        dedupeCaseInsensitive: false,
      }),
    ).toEqual(["B", "a", "A", "b"]);
  });

  test("normalizeFacetArray", () => {
    expect(normalizeFacetArray(["B", "a", "A", "b"])).toEqual(["a", "b"]);
  });

  test("normalizeNullableString", () => {
    expect(normalizeNullableString(" hello ")).toBe("hello");
    expect(normalizeNullableString("   ")).toBeNull();
    expect(normalizeNullableString(123)).toBeNull();
  });

  test("toIsoString", () => {
    const d = new Date("2026-05-24T00:00:00.000Z");
    expect(toIsoString(d)).toBe(d.toISOString());

    const isoStr = "2026-05-24T12:34:56.000Z";
    expect(toIsoString(isoStr)).toBe(isoStr);

    expect(toIsoString("invalid-date")).toBe(new Date(0).toISOString());
    expect(toIsoString(null)).toBe(new Date(0).toISOString());
    expect(toIsoString(123)).toBe(new Date(0).toISOString());
  });
});
