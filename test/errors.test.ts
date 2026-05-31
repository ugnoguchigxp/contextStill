import { describe, expect, test } from "vitest";
import { ContextStillError, isContextStillError } from "../src/lib/errors.js";

describe("error utilities", () => {
  test("ContextStillError captures code and details", () => {
    const error = new ContextStillError("TEST_ERROR", "Something failed", { foo: "bar" });
    expect(error.code).toBe("TEST_ERROR");
    expect(error.message).toBe("Something failed");
    expect(error.details).toEqual({ foo: "bar" });
    expect(error.name).toBe("ContextStillError");
  });

  test("isContextStillError identifies error correctly", () => {
    const error = new ContextStillError("CODE", "MSG");
    expect(isContextStillError(error)).toBe(true);
    expect(isContextStillError(new Error("standard"))).toBe(false);
    expect(isContextStillError({})).toBe(false);
    expect(isContextStillError(null)).toBe(false);
  });
});
