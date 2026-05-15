import { describe, expect, test } from "vitest";
import {
  extractRemainderFromPathname,
  filePathToSlug,
  sanitizeSlug,
  isSafeSlug,
  assertSafeSlug,
} from "../src/modules/sources/wiki/slug.js";

describe("Slug Utilities", () => {
  test("extractRemainderFromPathname", () => {
    expect(extractRemainderFromPathname("/wiki/foo/bar", "/wiki")).toBe("foo/bar");
    expect(extractRemainderFromPathname("/other/path", "/wiki")).toBe("");
    expect(extractRemainderFromPathname("/wiki/%ZZ", "/wiki")).toBe("\0"); // Invalid URI
  });

  test("filePathToSlug", () => {
    expect(filePathToSlug("index.md")).toBe("");
    expect(filePathToSlug("foo/index.md")).toBe("foo");
    expect(filePathToSlug("foo/bar.md")).toBe("foo/bar");
  });

  test("sanitizeSlug", () => {
    expect(sanitizeSlug("  /foo//bar/  ")).toBe("foo/bar");
    expect(sanitizeSlug("foo\\bar")).toBe("foo/bar");
  });

  test("isSafeSlug", () => {
    expect(isSafeSlug("foo/bar")).toBe(true);
    expect(isSafeSlug("")).toBe(true);
    expect(isSafeSlug("foo/../bar")).toBe(false);
    expect(isSafeSlug("foo/./bar")).toBe(false);
    expect(isSafeSlug("foo/\0/bar")).toBe(false);
  });

  test("assertSafeSlug", () => {
    expect(assertSafeSlug("foo/bar")).toBe("foo/bar");
    expect(() => assertSafeSlug("foo/../bar")).toThrow("Invalid page slug");
  });
});
