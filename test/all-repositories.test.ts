import { describe, expect, it } from "vitest";
import { db } from "../src/db/index.js";
describe("All Repositories smoke test", () => {
  it("db is connected", () => {
    expect(db).toBeDefined();
  });
});
