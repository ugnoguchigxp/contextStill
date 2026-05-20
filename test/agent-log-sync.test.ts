import { afterEach, describe, expect, test } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ingestAntigravityLogsFromRoot,
  ingestCodexLogsFromRoots,
  normalizeIngestCursor,
  processCodexJsonlDelta,
} from "../src/modules/agent-log-sync/ingest.service.js";
import {
  buildReadableTranscript,
  buildDedupeKey,
  chunkMessages,
  extractUnifiedDiffsFromText,
} from "../src/modules/agent-log-sync/sync.service.js";
import { parseVibeMemoryTurns } from "../web/src/modules/admin/components/chat-rendering.ts";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-router-agent-log-sync-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function codexLine(content: unknown, role: "user" | "assistant" = "assistant"): string {
  return `${JSON.stringify({
    timestamp: "2026-05-14T00:00:00.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role,
      content,
    },
  })}\n`;
}

function codexSessionMeta(cwd: string): string {
  return `${JSON.stringify({
    timestamp: "2026-05-14T00:00:00.000Z",
    type: "session_meta",
    payload: {
      id: "session-abc",
      timestamp: "2026-05-14T00:00:00.000Z",
      cwd,
    },
  })}\n`;
}

describe("agent log sync ingestion", () => {
  test("processCodexJsonlDelta extracts Codex message text arrays", () => {
    const line =
      codexSessionMeta("/Users/y.noguchi/Code/memoryRouter") +
      codexLine([{ type: "output_text", text: "hello from codex" }]);
    const result = processCodexJsonlDelta("/tmp/rollout-abc.jsonl", line, 0);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.role).toBe("assistant");
    expect(result.messages[0]?.content).toBe("hello from codex");
    expect(result.messages[0]?.metadata.sessionId).toBe("session-abc");
    expect(result.messages[0]?.metadata.cwd).toBe("/Users/y.noguchi/Code/memoryRouter");
    expect(result.messages[0]?.metadata.projectName).toBe("memoryRouter");
    expect(result.messages[0]?.metadata.projectRoot).toBe("/Users/y.noguchi/Code/memoryRouter");
    expect(result.nextOffset).toBe(Buffer.byteLength(line, "utf8"));
  });

  test("processCodexJsonlDelta extracts apply_patch tool calls as agent diff content", () => {
    const line = `${JSON.stringify({
      timestamp: "2026-05-14T00:00:00.000Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "apply_patch",
        input: "*** Begin Patch\n*** Add File: src/a.ts\n+export const a = 1;\n*** End Patch",
      },
    })}\n`;
    const result = processCodexJsonlDelta("/tmp/rollout-abc.jsonl", line, 0);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.metadata.messageKind).toBe("tool_call");
    expect(result.messages[0]?.content).toContain("*** Begin Patch");
  });

  test("buildReadableTranscript hides tool call records from chat content", () => {
    const transcript = buildReadableTranscript([
      { role: "user", content: "READMEを直してください", metadata: {} },
      {
        role: "assistant",
        content: "*** Begin Patch\n*** Add File: src/a.ts\n+export const a = 1;\n*** End Patch",
        metadata: { messageKind: "tool_call", toolName: "apply_patch" },
      },
      { role: "assistant", content: "修正しました", metadata: {} },
    ]);

    expect(transcript).toContain("USER: READMEを直してください");
    expect(transcript).toContain("ASSISTANT: 修正しました");
    expect(transcript).not.toContain("*** Begin Patch");
  });

  test("buildReadableTranscript strips embedded diffs from natural chat records", () => {
    const transcript = buildReadableTranscript([
      {
        role: "assistant",
        content: `差分を作りました。

\`\`\`diff
diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-old
+new
\`\`\`

確認してください。`,
        metadata: {},
      },
    ]);

    expect(transcript).toBe("ASSISTANT: 差分を作りました。\n\n確認してください。");
    expect(transcript).not.toContain("diff --git");
  });

  test("processCodexJsonlDelta keeps incomplete trailing JSONL for the next run", () => {
    const result = processCodexJsonlDelta("/tmp/rollout-abc.jsonl", '{"type": "response_item"', 10);

    expect(result.messages).toHaveLength(0);
    expect(result.nextOffset).toBe(10);
  });

  test("normalizeIngestCursor rejects malformed cursor values", () => {
    const cursor = normalizeIngestCursor({
      "/tmp/a.jsonl": { offset: "12", mtimeMs: "100" },
      "/tmp/b.jsonl": { offset: -1, mtimeMs: Number.NaN },
      invalid: null,
    });

    expect(cursor["/tmp/a.jsonl"]).toEqual({ offset: 12, mtimeMs: 100 });
    expect(cursor["/tmp/b.jsonl"]).toEqual({ offset: 0, mtimeMs: 0 });
    expect(cursor.invalid).toBeUndefined();
  });

  test("ingestCodexLogsFromRoots skips old files on the initial lookback", async () => {
    const root = await makeTempDir();
    const filePath = path.join(root, "old.jsonl");
    const content = codexLine("old message");
    await fs.writeFile(filePath, content, "utf-8");
    const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await fs.utimes(filePath, oldDate, oldDate);

    const result = await ingestCodexLogsFromRoots([root], undefined, {}, 1);

    expect(result.messages).toHaveLength(0);
    expect(result.checkedFiles).toBe(1);
    expect(result.cursor[filePath]?.offset).toBe(Buffer.byteLength(content, "utf8"));
  });

  test("ingestAntigravityLogsFromRoot separates natural chat from tool calls", async () => {
    const root = await makeTempDir();
    const logDir = path.join(root, "session-a", ".system_generated", "logs");
    const filePath = path.join(logDir, "overview.txt");
    const userLine = JSON.stringify({
      step_index: 0,
      source: "USER_EXPLICIT",
      type: "USER_INPUT",
      created_at: "2026-05-14T00:00:00.000Z",
      content:
        "<USER_REQUEST>\n全ての変更点をコミットしてください\n</USER_REQUEST>\n<ADDITIONAL_METADATA>hidden editor context</ADDITIONAL_METADATA>",
    });
    const toolLine = JSON.stringify({
      step_index: 4,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      created_at: "2026-05-14T00:00:01.000Z",
      tool_calls: [
        {
          name: "run_command",
          args: {
            CommandLine: '"pwd && git status"',
            Cwd: '"/tmp/repo"',
            toolSummary: '"Git status check"',
          },
        },
      ],
    });
    const content = `${userLine}\n${toolLine}\n`;
    await fs.mkdir(logDir, { recursive: true });
    await fs.writeFile(filePath, content, "utf-8");

    const result = await ingestAntigravityLogsFromRoot(root, undefined, {}, 1);
    const transcript = buildReadableTranscript(result.messages);

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]?.content).toBe("全ての変更点をコミットしてください");
    expect(result.messages[0]?.metadata.projectName).toBeUndefined();
    expect(result.messages[1]?.metadata.messageKind).toBe("tool_call");
    expect(result.messages[1]?.metadata.toolCalls).toMatchObject([
      {
        name: "run_command",
        summary: "Git status check",
        commandLine: "pwd && git status",
        cwd: "/tmp/repo",
      },
    ]);
    expect(transcript).toContain("USER: 全ての変更点をコミットしてください");
    expect(transcript).not.toContain("Git status check");
    expect(result.cursor[filePath]?.offset).toBe(Buffer.byteLength(content, "utf8"));
  });

  test("ingestAntigravityLogsFromRoot hides file view actions from readable chat", async () => {
    const root = await makeTempDir();
    const logDir = path.join(root, "session-b", ".system_generated", "logs");
    const filePath = path.join(logDir, "overview.txt");
    const viewedFilePath = path.resolve("src/config.ts");
    const viewLine = JSON.stringify({
      step_index: 8,
      source: "USER_EXPLICIT",
      type: "VIEW_FILE",
      created_at: "2026-05-14T00:00:02.000Z",
      content: `The USER performed the following action:\nShow the contents of file ${viewedFilePath} from lines 1 to 2\nFile Path: \`file://${viewedFilePath}\`\n<truncated 123 bytes>`,
    });
    const assistantLine = JSON.stringify({
      step_index: 9,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      created_at: "2026-05-14T00:00:03.000Z",
      content: "確認しました。\n<truncated 99 bytes>",
    });
    const content = `${viewLine}\n${assistantLine}\n`;
    await fs.mkdir(logDir, { recursive: true });
    await fs.writeFile(filePath, content, "utf-8");

    const result = await ingestAntigravityLogsFromRoot(root, undefined, {}, 1);
    const transcript = buildReadableTranscript(result.messages);

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]?.metadata.messageKind).toBe("tool_call");
    expect(result.messages[0]?.metadata.toolCalls).toMatchObject([
      {
        name: "VIEW_FILE",
        summary: "Show lines 1-2",
        action: "VIEW_FILE",
        targetFile: viewedFilePath,
        sourceTruncated: true,
        reconstructedFromFile: true,
      },
    ]);
    expect(
      String(
        (result.messages[0]?.metadata.toolCalls as Array<{ contentPreview?: string }>)[0]
          ?.contentPreview,
      ),
    ).toContain("1:");
    expect(result.messages[0]?.metadata.projectName).toBe("memoryRouter");
    expect(transcript).toBe("ASSISTANT: 確認しました。\n<truncated 99 bytes>");
    expect(transcript).not.toContain("The USER performed");
  });

  test("chunkMessages obeys message and character limits", () => {
    const messages = [
      { role: "user" as const, content: "aaa", metadata: {} },
      { role: "assistant" as const, content: "bbb", metadata: {} },
      { role: "user" as const, content: "ccc", metadata: {} },
    ];

    expect(chunkMessages(messages, 2, 100)).toHaveLength(2);
    expect(chunkMessages(messages, 10, 5)).toHaveLength(3);
  });

  test("buildDedupeKey is stable by source session and chunk", () => {
    const first = buildDedupeKey({
      sourceId: "codex_logs",
      memorySessionId: "codex_logs:abc",
      chunkIndex: 0,
    });
    const second = buildDedupeKey({
      sourceId: "codex_logs",
      memorySessionId: "codex_logs:abc",
      chunkIndex: 0,
    });
    const changed = buildDedupeKey({
      sourceId: "codex_logs",
      memorySessionId: "codex_logs:abc",
      chunkIndex: 1,
    });

    expect(first).toBe(second);
    expect(first).not.toBe(changed);
  });

  test("extractUnifiedDiffsFromText pulls fenced diffs from transcripts", () => {
    const diff = extractUnifiedDiffsFromText(`ASSISTANT: here is the patch

\`\`\`diff
diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-old
+new
\`\`\`
`);

    expect(diff).toContain("diff --git");
    expect(diff).toContain("src/a.ts");
  });

  test("extractUnifiedDiffsFromText pulls apply_patch blocks from transcripts", () => {
    const diff = extractUnifiedDiffsFromText(`ASSISTANT: tool call
*** Begin Patch
*** Add File: src/a.ts
+export const a = 1;
*** End Patch
`);

    expect(diff).toContain("*** Begin Patch");
    expect(diff).toContain("src/a.ts");
  });

  test("parseVibeMemoryTurns keeps only readable chat from raw Antigravity overview lines", () => {
    const raw = [
      `ASSISTANT: ${JSON.stringify({
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        content:
          "<USER_REQUEST>\nfrontendを見やすくしてください\n</USER_REQUEST>\n<ADDITIONAL_METADATA>active document path</ADDITIONAL_METADATA>",
      })}`,
      JSON.stringify({
        step_index: 4,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        tool_calls: [{ name: "run_command", args: { toolSummary: "Git status check" } }],
      }),
    ].join("\n");

    const turns = parseVibeMemoryTurns(raw);

    expect(turns).toEqual([{ role: "user", content: "frontendを見やすくしてください" }]);
  });

  test("parseVibeMemoryTurns hides file view action lines but preserves source truncation markers", () => {
    const turns = parseVibeMemoryTurns(
      [
        "USER: The USER performed the following action:",
        "Show the contents of file /tmp/a.ts from lines 1 to 2",
        "File Path: `file:///tmp/a.ts`",
        "<truncated 123 bytes>",
        "",
        "ASSISTANT: 確認しました。\n<truncated 99 bytes>",
      ].join("\n"),
    );

    expect(turns).toEqual([{ role: "assistant", content: "確認しました。\n<truncated 99 bytes>" }]);
  });
});
