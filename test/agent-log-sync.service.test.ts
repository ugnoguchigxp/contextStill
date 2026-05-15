import { describe, expect, test, vi, beforeEach } from "vitest";
import {
  chunkMessages,
  buildReadableTranscript,
  syncAllAgentLogs,
} from "../src/modules/agent-log-sync/sync.service.js";
import {
  ingestCodexLogs,
  ingestAntigravityLogs,
} from "../src/modules/agent-log-sync/ingest.service.js";
import { db } from "../src/db/client.js";

vi.mock("../src/modules/agent-log-sync/ingest.service.js");
vi.mock("../src/db/client.js", () => {
  const chain = {
    values: vi.fn(() => chain),
    onConflictDoUpdate: vi.fn(() => chain),
    onConflictDoNothing: vi.fn(() => chain),
    returning: vi.fn(() => [{ id: "inserted-id" }]),
  };
  const mockInsert = vi.fn(() => chain);

  return {
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => []),
        })),
      })),
      insert: mockInsert,
      transaction: vi.fn((cb) => cb({ insert: mockInsert })),
    },
  };
});

describe("Agent Log Sync Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ingestAntigravityLogs).mockResolvedValue({
      ok: true,
      messages: [],
      cursor: {},
      checkedFiles: 0,
      errors: [],
      warnings: [],
      skipped: true,
    } as any);
    vi.mocked(ingestCodexLogs).mockResolvedValue({
      ok: true,
      messages: [],
      cursor: {},
      checkedFiles: 0,
      errors: [],
      warnings: [],
      skipped: true,
    } as any);
  });

  test("chunkMessages splits by count and size", () => {
    const messages = [
      { role: "user", content: "Hello", metadata: {} },
      { role: "assistant", content: "Hi", metadata: {} },
      { role: "user", content: "Long message ".repeat(10), metadata: {} },
    ] as any;

    const chunks = chunkMessages(messages, 2, 20);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(2); // Hello + Hi = ~7 chars < 20, but count limit reached
    expect(chunks[1]).toHaveLength(1); // Long message
  });

  test("buildReadableTranscript strips diffs and empty lines", () => {
    const messages = [
      {
        role: "user",
        content:
          "Check this diff:\ndiff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new",
        metadata: { messageKind: "chat" },
      },
      { role: "assistant", content: "Got it.", metadata: { messageKind: "chat" } },
    ] as any;

    const transcript = buildReadableTranscript(messages);
    expect(transcript).toContain("USER: Check this diff:");
    expect(transcript).not.toContain("diff --git");
    expect(transcript).toContain("ASSISTANT: Got it.");
  });

  test("syncAllAgentLogs handles ingest failure", async () => {
    vi.mocked(ingestCodexLogs).mockResolvedValue({
      ok: false,
      errors: ["Ingest failed"],
      warnings: [],
      messages: [],
      cursor: {},
      maxObservedMtimeMs: 0,
      checkedFiles: 0,
    } as any);

    const summary = await syncAllAgentLogs();
    expect(summary.ok).toBe(false);
    expect(summary.sources[0].errors).toContain("Ingest failed");
  });

  test("deduplicates vibe memories", async () => {
    vi.mocked(ingestCodexLogs).mockResolvedValue({
      ok: true,
      messages: [
        {
          role: "user",
          content: "M1",
          metadata: { sessionId: "s1", timestamp: new Date().toISOString() },
        },
        {
          role: "user",
          content: "M2",
          metadata: { sessionId: "s2", timestamp: new Date().toISOString() },
        },
      ],
      cursor: {},
      maxObservedMtimeMs: 2000,
      checkedFiles: 1,
      errors: [],
      warnings: [],
    } as any);

    // First vibeMemory insert succeeds, second fails (dedupe), then syncState update succeeds
    const chain = db.insert({} as any) as any;

    chain.returning
      .mockResolvedValueOnce([{ id: "m1" }]) // Vibe 1
      .mockResolvedValueOnce([]) // Vibe 2 (dedupe)
      .mockResolvedValueOnce([{ id: "s1" }]); // Sync state

    const summary = await syncAllAgentLogs();
    expect(summary.imported).toBe(1);
  });

  test("buildReadableTranscript excludes tool calls", () => {
    const messages = [
      { role: "assistant", content: "calling tool", metadata: { messageKind: "tool_call" } },
      { role: "assistant", content: "Result", metadata: { messageKind: "chat" } },
    ] as any;
    const transcript = buildReadableTranscript(messages);
    expect(transcript).not.toContain("calling tool");
    expect(transcript).toContain("ASSISTANT: Result");
  });

  test("syncAllAgentLogs inserts diff entries", async () => {
    vi.mocked(ingestCodexLogs).mockResolvedValue({
      ok: true,
      messages: [
        {
          role: "assistant",
          content: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new",
          metadata: { sessionId: "s1", timestamp: new Date().toISOString() },
        },
      ],
      cursor: {},
      maxObservedMtimeMs: 3000,
      checkedFiles: 1,
      errors: [],
      warnings: [],
    } as any);

    const summary = await syncAllAgentLogs();
    expect(summary.insertedDiffs).toBeGreaterThan(0);
  });
});
