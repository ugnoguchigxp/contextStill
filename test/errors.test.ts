import { describe, expect, test } from "vitest";
import { MemoryRouterError, isMemoryRouterError } from "../src/lib/errors.js";

describe("error utilities", () => {
  test("MemoryRouterError captures code and details", () => {
    const error = new MemoryRouterError("TEST_ERROR", "Something failed", { foo: "bar" });
    expect(error.code).toBe("TEST_ERROR");
    expect(error.message).toBe("Something failed");
    expect(error.details).toEqual({ foo: "bar" });
    expect(error.name).toBe("MemoryRouterError");
  });

  test("isMemoryRouterError identifies error correctly", () => {
    const error = new MemoryRouterError("CODE", "MSG");
    expect(isMemoryRouterError(error)).toBe(true);
    expect(isMemoryRouterError(new Error("standard"))).toBe(false);
    expect(isMemoryRouterError({})).toBe(false);
    expect(isMemoryRouterError(null)).toBe(false);
  });
});
