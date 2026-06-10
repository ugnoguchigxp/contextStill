import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatToolCallSummary,
  parseAntigravityFileViewAction,
  pushAntigravityToolMessage,
  reconstructFileViewContent,
  summarizeAntigravityUserAction,
} from "../src/modules/agent-log-sync/antigravity-parser.js";

const mockFsReadFile = vi.fn();
vi.mock("node:fs/promises", () => {
  return {
    default: {
      readFile: (...args: any[]) => mockFsReadFile(...args),
    },
  };
});

describe("antigravity-parser extra helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("formatToolCallSummary", () => {
    it("formats command tool calls correctly", () => {
      const tc = {
        name: "run_command",
        summary: "Git status check",
        commandLine: "git status",
        cwd: "/path/to/repo",
      };
      expect(formatToolCallSummary(tc)).toBe(
        "run_command - Git status check | $ git status | cwd: /path/to/repo",
      );
    });

    it("formats file edit tool calls correctly", () => {
      const tc = {
        name: "write_file",
        summary: "create main file",
        targetFile: "src/main.ts",
      };
      expect(formatToolCallSummary(tc)).toBe("write_file - create main file | file: src/main.ts");
    });

    it("formats simple tool calls without details", () => {
      const tc = { name: "my_tool" };
      expect(formatToolCallSummary(tc)).toBe("my_tool");
    });
  });

  describe("parseAntigravityFileViewAction", () => {
    it("parses file URL correctly", () => {
      const content =
        "The USER performed the following action:\nFile Path: `file:///Users/test/file.ts` from lines 10 to 20";
      const result = parseAntigravityFileViewAction(content);
      expect(result).not.toBeNull();
      expect(result?.filePath).toBe("/Users/test/file.ts");
      expect(result?.startLine).toBe(10);
      expect(result?.endLine).toBe(20);
    });

    it("parses relative path in action description", () => {
      const content = "Show the contents of file src/index.ts from lines 5 to 5";
      const result = parseAntigravityFileViewAction(content);
      expect(result).not.toBeNull();
      expect(result?.filePath).toBe("src/index.ts");
      expect(result?.startLine).toBe(5);
      expect(result?.endLine).toBe(5);
    });

    it("returns null if no file path matches", () => {
      const content = "The USER clicked button X";
      expect(parseAntigravityFileViewAction(content)).toBeNull();
    });
  });

  describe("reconstructFileViewContent", () => {
    it("reconstructs requested line range from file content", async () => {
      mockFsReadFile.mockResolvedValue("line1\nline2\nline3\nline4\nline5");
      const action = {
        filePath: "mock.ts",
        startLine: 2,
        endLine: 4,
      };
      const result = await reconstructFileViewContent(action);
      expect(result).toBe("2: line2\n3: line3\n4: line4");
    });

    it("returns null on file read error", async () => {
      mockFsReadFile.mockRejectedValue(new Error("read error"));
      const action = {
        filePath: "mock.ts",
        startLine: 1,
        endLine: 5,
      };
      expect(await reconstructFileViewContent(action)).toBeNull();
    });

    it("returns null if range is invalid", async () => {
      const action = {
        filePath: "mock.ts",
        startLine: null,
        endLine: null,
      };
      expect(await reconstructFileViewContent(action)).toBeNull();
    });
  });

  describe("summarizeAntigravityUserAction", () => {
    it("summarizes file view action with reconstructed content", async () => {
      mockFsReadFile.mockResolvedValue("line1\nline2\nline3");
      const content = "Show the contents of file /tmp/a.ts from lines 1 to 2";
      const result = await summarizeAntigravityUserAction("VIEW_FILE", content);
      expect(result.name).toBe("VIEW_FILE");
      expect(result.targetFile).toBe("/tmp/a.ts");
      expect(result.contentPreview).toBe("1: line1\n2: line2");
      expect(result.reconstructedFromFile).toBe(true);
    });

    it("summarizes generic action using first non-empty line", async () => {
      const content =
        "The USER performed the following action:\n\nClicked on elements\nAnd did nothing";
      const result = await summarizeAntigravityUserAction("CLICK", content);
      expect(result.name).toBe("CLICK");
      expect(result.summary).toBe("Clicked on elements");
    });
  });

  describe("pushAntigravityToolMessage", () => {
    it("does nothing if toolCalls list is empty", () => {
      const messages: any[] = [];
      pushAntigravityToolMessage({
        messages,
        toolCalls: [],
        logPath: "test.log",
        sessionId: "s1",
        createdAt: "2026-06-11",
        stepIndex: 1,
        recordType: "PLANNER_RESPONSE",
      });
      expect(messages).toHaveLength(0);
    });

    it("pushes a formatted tool call message into array", () => {
      const messages: any[] = [];
      const toolCalls = [{ name: "test_tool", summary: "run test", cwd: "/tmp" }];
      pushAntigravityToolMessage({
        messages,
        toolCalls,
        logPath: "test.log",
        sessionId: "s1",
        createdAt: "2026-06-11",
        stepIndex: 1,
        recordType: "PLANNER_RESPONSE",
      });
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe("assistant");
      expect(messages[0].content).toContain("test_tool - run test | cwd: /tmp");
      expect(messages[0].metadata).toMatchObject({
        source: "Antigravity",
        sessionId: "s1",
        sessionFile: "test.log",
        timestamp: "2026-06-11",
        stepIndex: 1,
        messageKind: "tool_call",
        toolCalls,
      });
    });
  });
});
