import { describe, expect, it } from "vitest";
import {
  parseClaudeLogLine,
  parseClaudeSessionLog,
  sessionIdFromFile,
} from "../src/modules/agent-log-sync/claude-parser.js";

describe("claude-parser", () => {
  describe("sessionIdFromFile", () => {
    it("extracts session name from unix path", () => {
      expect(sessionIdFromFile("/path/to/my-session.jsonl")).toBe("my-session");
    });

    it("extracts session name from windows path", () => {
      expect(sessionIdFromFile("C:\\path\\to\\another-session.jsonl")).toBe("another-session");
    });

    it("extracts session name from filename only", () => {
      expect(sessionIdFromFile("simple.jsonl")).toBe("simple");
    });

    it("handles empty or extensionless inputs safely", () => {
      expect(sessionIdFromFile("")).toBe("default");
    });
  });

  describe("parseClaudeLogLine", () => {
    it("returns null for non-JSON lines", () => {
      expect(parseClaudeLogLine("not a json", "test.log", "session1")).toBeNull();
    });

    it("returns null if type is neither user nor assistant", () => {
      const line = JSON.stringify({ type: "system", message: { content: "hello" } });
      expect(parseClaudeLogLine(line, "test.log", "session1")).toBeNull();
    });

    it("returns null if message object is missing", () => {
      const line = JSON.stringify({ type: "user" });
      expect(parseClaudeLogLine(line, "test.log", "session1")).toBeNull();
    });

    describe("user message type", () => {
      it("returns null if message content is empty", () => {
        const line = JSON.stringify({ type: "user", message: { content: "" } });
        expect(parseClaudeLogLine(line, "test.log", "session1")).toBeNull();
      });

      it("parses valid user messages and filters sensitive data", () => {
        const line = JSON.stringify({
          type: "user",
          timestamp: "2026-06-11T00:00:00Z",
          message: { content: "I need to fix sk-abcdefghijklmnopqrstuvwxyz0123456789 key" },
        });

        const result = parseClaudeLogLine(line, "test.log", "session1");
        expect(result).not.toBeNull();
        expect(result?.role).toBe("user");
        expect(result?.content).toBe("I need to fix [REMOVED SENSITIVE DATA] key");
        expect(result?.metadata).toMatchObject({
          source: "Claude",
          sourceId: "claude_logs",
          sessionId: "session1",
          sessionFile: "test.log",
          timestamp: "2026-06-11T00:00:00Z",
        });
      });
    });

    describe("assistant message type", () => {
      it("parses assistant message with string content", () => {
        const line = JSON.stringify({
          type: "assistant",
          message: { content: "Here is the plan." },
        });

        const result = parseClaudeLogLine(line, "test.log", "session1");
        expect(result).not.toBeNull();
        expect(result?.role).toBe("assistant");
        expect(result?.content).toBe("Here is the plan.");
        expect(result?.metadata.messageKind).toBe("chat");
      });

      it("parses assistant message with structured content array", () => {
        const line = JSON.stringify({
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "Writing test cases." },
              {
                type: "tool_use",
                name: "write_file",
                input: {
                  filePath: "src/main.ts",
                  content: "console.log('hello')",
                },
              },
              {
                type: "tool_use",
                name: "run_command",
                input: {
                  command: "bun test",
                },
              },
            ],
          },
        });

        const result = parseClaudeLogLine(line, "test.log", "session1");
        expect(result).not.toBeNull();
        expect(result?.role).toBe("assistant");
        expect(result?.content).toBe("Writing test cases.");
        expect(result?.metadata.messageKind).toBe("chat");
        expect(result?.metadata.toolCalls).toEqual([
          {
            name: "write_file",
            summary: "write_file",
            commandLine: undefined,
            targetFile: "src/main.ts",
            contentPreview: "console.log('hello')",
          },
          {
            name: "run_command",
            summary: "run_command",
            commandLine: "bun test",
            targetFile: undefined,
            contentPreview: undefined,
          },
        ]);
      });

      it("uses tool calls list as final content if text is empty", () => {
        const line = JSON.stringify({
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                name: "run_command",
                input: {
                  command: "node run.js",
                },
              },
            ],
          },
        });

        const result = parseClaudeLogLine(line, "test.log", "session1");
        expect(result).not.toBeNull();
        expect(result?.content).toBe("run_command");
        expect(result?.metadata.messageKind).toBe("tool_call");
      });
    });
  });

  describe("parseClaudeSessionLog", () => {
    it("splits content by lines and parses valid message entries", () => {
      const content = [
        JSON.stringify({ type: "user", message: { content: "first query" } }),
        "", // empty line
        "invalid line",
        JSON.stringify({ type: "assistant", message: { content: "first response" } }),
      ].join("\n");

      const result = parseClaudeSessionLog(content, "session.log", "session-id");
      expect(result).toHaveLength(2);
      expect(result[0].content).toBe("first query");
      expect(result[1].content).toBe("first response");
    });
  });
});
