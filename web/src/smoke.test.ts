import { describe, expect, test } from "vitest";

describe("web smoke", () => {
  test("basic arithmetic sanity", () => {
    expect(1 + 1).toBe(2);
  });
});
