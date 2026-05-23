import { describe, expect, test } from "vitest";
import { parseArgs } from "../src/cli/init-project.js";

describe("init-project CLI args", () => {
  test("falls back to env locale when --lang is not set", () => {
    const options = parseArgs([], { MEMORY_ROUTER_LANG: "en" });
    expect(options.lang).toBe("en");
    expect(options.smokeGoal).toContain("initial setup");
  });

  test("accepts --lang en|ja", () => {
    const options = parseArgs(["--lang", "ja"], {});
    expect(options.lang).toBe("ja");
    expect(options.smokeGoal).toContain("初回セットアップ");
  });

  test("rejects unsupported --lang", () => {
    expect(() => parseArgs(["--lang", "fr"], {})).toThrow("--lang currently supports only: en, ja");
  });
});
