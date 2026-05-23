import path from "node:path";
import { describe, expect, test } from "vitest";
import { parseSetupArgs } from "../src/cli/setup.js";

describe("setup CLI args", () => {
  test("uses env locale fallback by default", () => {
    const options = parseSetupArgs([], { MEMORY_ROUTER_LANG: "en" });
    expect(options.lang).toBe("en");
    expect(options.langExplicit).toBe(false);
  });

  test("parses supported options", () => {
    const options = parseSetupArgs(
      [
        "--dry-run",
        "--start-db",
        "--no-migrate",
        "--skip-init",
        "--wiki-root",
        "./wiki",
        "--lang",
        "ja",
      ],
      {},
    );
    expect(options.dryRun).toBe(true);
    expect(options.startDb).toBe(true);
    expect(options.noMigrate).toBe(true);
    expect(options.skipInit).toBe(true);
    expect(options.wikiRoot).toBe(path.resolve("./wiki"));
    expect(options.lang).toBe("ja");
    expect(options.langExplicit).toBe(true);
  });

  test("rejects unsupported lang", () => {
    expect(() => parseSetupArgs(["--lang", "fr"], {})).toThrow(
      "--lang currently supports only: en, ja",
    );
  });
});
