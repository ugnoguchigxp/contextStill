import { describe, expect, test } from "vitest";
import { getExposedToolEntries } from "../src/mcp/tools/index.js";

const DISALLOWED_TOP_LEVEL_SCHEMA_KEYS = ["oneOf", "anyOf", "allOf", "enum", "not"] as const;

describe("MCP schema compatibility", () => {
  test("exposes only object parameter schemas without top-level composition keywords", () => {
    for (const tool of getExposedToolEntries()) {
      expect(tool.inputSchema, `${tool.name} inputSchema`).toMatchObject({ type: "object" });

      for (const key of DISALLOWED_TOP_LEVEL_SCHEMA_KEYS) {
        expect(
          tool.inputSchema,
          `${tool.name} inputSchema must not use top-level ${key}`,
        ).not.toHaveProperty(key);
      }
    }
  });
});
