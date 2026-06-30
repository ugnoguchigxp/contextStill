import { describe, expect, test } from "vitest";
import { settingsSections } from "../web/src/App";

describe("settings app routes", () => {
  test("allows the LLM Pool settings section", () => {
    expect(settingsSections.has("llmpool")).toBe(true);
  });
});
