import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { executeMcpEvidenceTool } from "../src/modules/distillation/mcp-evidence-tools.service.js";

// config モック
vi.mock("../src/config.js", () => ({
  groupedConfig: {
    distillationTools: {
      timeoutMs: 5000,
    },
  },
}));

// MCP SDK Client モック
const mockConnect = vi.fn();
const mockCallTool = vi.fn();
const mockClose = vi.fn();

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => {
  return {
    Client: class {
      connect = mockConnect;
      callTool = mockCallTool;
      close = mockClose;
    },
  };
});

// MCP SDK StdioClientTransport モック
const mockTransportClose = vi.fn();
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => {
  return {
    StdioClientTransport: class {
      close = mockTransportClose;
    },
  };
});

describe("mcp-evidence-tools.service", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    mockConnect.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);
    mockTransportClose.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("resolveServerConfig behavior through executeMcpEvidenceTool", () => {
    test("returns unavailable result if server is not configured", async () => {
      // Env variables are missing
      const result = await executeMcpEvidenceTool("context7", {});
      expect(result.ok).toBe(false);
      expect(result.error).toContain("MCP server is not configured");
    });

    test("successfully resolves config with JSON args and runs tool", async () => {
      process.env.CONTEXT_STILL_CONTEXT7_MCP_COMMAND = "node";
      process.env.CONTEXT_STILL_CONTEXT7_MCP_ARGS = '["--foo", "bar"]';
      process.env.CONTEXT_STILL_CONTEXT7_MCP_CWD = "/mock/cwd";
      process.env.CONTEXT_STILL_CONTEXT7_MCP_TOOL = "custom-tool";

      mockCallTool.mockResolvedValue({
        content: [{ type: "text", text: "Tool output" }],
      });

      const result = await executeMcpEvidenceTool("context7", { query: "test" });
      expect(result.ok).toBe(true);
      expect(result.content).toBe("Tool output");
      expect(result.metadata?.mcpToolName).toBe("custom-tool");
    });

    test("resolves config with whitespace-separated args", async () => {
      process.env.CONTEXT_STILL_CONTEXT7_MCP_COMMAND = "node";
      process.env.CONTEXT_STILL_CONTEXT7_MCP_ARGS = "--foo bar";

      mockCallTool.mockResolvedValue({
        content: [{ type: "text", text: "Output" }],
      });

      const result = await executeMcpEvidenceTool("context7", {});
      expect(result.ok).toBe(true);
      expect(result.content).toBe("Output");
    });
  });

  describe("content parsing and metadata resolution", () => {
    beforeEach(() => {
      process.env.CONTEXT_STILL_CONTEXT7_MCP_COMMAND = "node";
    });

    test("parses resource and resource_link content types", async () => {
      mockCallTool.mockResolvedValue({
        content: [
          { type: "text", text: "First Line" },
          {
            type: "resource",
            resource: { text: "Second Line", uri: "res://uri1" },
          },
          {
            type: "resource",
            resource: { uri: "res://uri2" }, // no text
          },
          { type: "resource_link", uri: "res://link" },
        ],
      });

      const result = await executeMcpEvidenceTool("context7", {});
      expect(result.content).toBe(
        "First Line\nSecond Line\nresource: res://uri1\nresource: res://uri2\nresource: res://link",
      );
      expect(result.metadata?.uri).toBe("res://uri1"); // first resource URI resolved
    });

    test("extracts metadata from structuredContent or _meta", async () => {
      mockCallTool.mockResolvedValue({
        content: [],
        structuredContent: {
          uri: "sc://uri",
          title: "SC Title",
          locator: "SC Locator",
        },
        _meta: {
          uri: "meta://uri",
          title: "Meta Title",
        },
      });

      const result = await executeMcpEvidenceTool("context7", {});
      expect(result.metadata?.uri).toBe("sc://uri");
      expect(result.metadata?.title).toBe("SC Title");
      expect(result.metadata?.locator).toBe("SC Locator");
    });

    test("falls back to _meta when structuredContent fields are missing", async () => {
      mockCallTool.mockResolvedValue({
        content: [],
        _meta: {
          uri: "meta://uri",
          title: "Meta Title",
          locator: "Meta Locator",
        },
      });

      const result = await executeMcpEvidenceTool("context7", {});
      expect(result.metadata?.uri).toBe("meta://uri");
      expect(result.metadata?.title).toBe("Meta Title");
      expect(result.metadata?.locator).toBe("Meta Locator");
    });

    test("returns error result if isError is returned in response", async () => {
      mockCallTool.mockResolvedValue({
        isError: true,
        content: [{ type: "text", text: "Internal server error" }],
      });

      const result = await executeMcpEvidenceTool("context7", {});
      expect(result.ok).toBe(false);
      expect(result.error).toBe("Internal server error");
    });
  });

  describe("error handling", () => {
    beforeEach(() => {
      process.env.CONTEXT_STILL_CONTEXT7_MCP_COMMAND = "node";
    });

    test("returns unavailable result when client connect throws", async () => {
      mockConnect.mockRejectedValue(new Error("Connection timeout"));

      const result = await executeMcpEvidenceTool("context7", {});
      expect(result.ok).toBe(false);
      expect(result.error).toBe("Connection timeout");
    });

    test("ensures client and transport close are called", async () => {
      mockCallTool.mockRejectedValue(new Error("Call failed"));

      await executeMcpEvidenceTool("context7", {});

      expect(mockClose).toHaveBeenCalled();
      expect(mockTransportClose).toHaveBeenCalled();
    });
  });
});
