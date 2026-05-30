import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configuredMcpEvidenceToolNames,
  referencesFromMcpToolEvents,
} from "../src/modules/coverEvidence/mcp-evidence.service.js";

describe("mcp-evidence.service", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("configuredMcpEvidenceToolNames", () => {
    it("returns empty array if no env variables are set", () => {
      process.env.MEMORY_ROUTER_CONTEXT7_MCP_COMMAND = undefined;
      process.env.MEMORY_ROUTER_DEEPWIKI_MCP_COMMAND = undefined;
      expect(configuredMcpEvidenceToolNames()).toEqual([]);
    });

    it("returns configured tool names", () => {
      process.env.MEMORY_ROUTER_CONTEXT7_MCP_COMMAND = "node some-cmd.js";
      process.env.MEMORY_ROUTER_DEEPWIKI_MCP_COMMAND = undefined;
      expect(configuredMcpEvidenceToolNames()).toEqual(["context7"]);

      process.env.MEMORY_ROUTER_DEEPWIKI_MCP_COMMAND = "python run.py";
      expect(configuredMcpEvidenceToolNames()).toEqual(["context7", "deepwiki"]);
    });

    it("ignores empty or whitespace command values", () => {
      process.env.MEMORY_ROUTER_CONTEXT7_MCP_COMMAND = "   ";
      process.env.MEMORY_ROUTER_DEEPWIKI_MCP_COMMAND = "";
      expect(configuredMcpEvidenceToolNames()).toEqual([]);
    });
  });

  describe("referencesFromMcpToolEvents", () => {
    it("filters out unsuccessful events", () => {
      const events = [
        {
          name: "context7",
          ok: false,
          metadata: { uri: "https://test.com" },
        },
      ];
      expect(referencesFromMcpToolEvents(events)).toEqual([]);
    });

    it("filters out unknown tool names", () => {
      const events = [
        {
          name: "unknown-tool",
          ok: true,
          metadata: { uri: "https://test.com" },
        },
      ];
      expect(referencesFromMcpToolEvents(events)).toEqual([]);
    });

    it("maps valid events to CoverEvidenceReference with default uri and metadata", () => {
      const events = [
        {
          name: "context7",
          ok: true,
          metadata: {
            uri: "https://test.com/evidence",
            locator: "line-42",
            title: "Verification Title",
          },
        },
        {
          name: "deepwiki",
          ok: true,
          metadata: {},
        },
      ];

      const result = referencesFromMcpToolEvents(events);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        kind: "context7",
        uri: "https://test.com/evidence",
        locator: "line-42",
        title: "Verification Title",
        note: "mcp evidence verified external claim",
        evidenceRole: "external_verification",
      });
      expect(result[1]).toEqual({
        kind: "deepwiki",
        uri: "deepwiki:evidence",
        locator: undefined,
        title: undefined,
        note: "mcp evidence verified external claim",
        evidenceRole: "external_verification",
      });
    });

    it("handles whitespace only metadata and assigns defaults", () => {
      const events = [
        {
          name: "context7",
          ok: true,
          metadata: {
            uri: "   ",
            locator: "  ",
            title: "\n",
          },
        },
      ];
      const result = referencesFromMcpToolEvents(events);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        kind: "context7",
        uri: "context7:evidence",
        locator: undefined,
        title: undefined,
        note: "mcp evidence verified external claim",
        evidenceRole: "external_verification",
      });
    });
  });
});
