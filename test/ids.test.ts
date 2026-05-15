import { describe, expect, test } from "vitest";
import { newId } from "../src/lib/ids.js";

describe("id utilities", () => {
  test("newId generates a valid UUID", () => {
    const id = newId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  test("newId generates unique IDs", () => {
    const id1 = newId();
    const id2 = newId();
    expect(id1).not.toBe(id2);
  });
});
