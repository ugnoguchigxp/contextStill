import { describe, expect, test } from "vitest";
import { canonicalSettingsSection, settingsSections } from "../web/src/App";
describe("settings routes", () => {
  test("has six canonical settings sections", () =>
    expect([...settingsSections]).toEqual([
      "general",
      "connections",
      "assignments",
      "execution",
      "retrieval",
      "advanced",
    ]));
  test.each([
    ["llmprovider", "connections"],
    ["llmpool", "execution"],
    ["taskrouting", "assignments"],
    ["distillation-runtime", "assignments"],
    ["search", "retrieval"],
    ["embedding", "retrieval"],
    ["unknown", "general"],
    ["connections", "connections"],
  ])("redirects %s to %s", (from, to) => expect(canonicalSettingsSection(from)).toBe(to));
});
