import { describe, expect, test } from "vitest";
import {
  isVibeMemoryWithinSinceDays,
  parseVibeMemoryCreatedAt,
  planVibeFindingEnqueueRows,
} from "../src/modules/findCandidate/vibe-finding-enqueue-planner.js";

describe("planVibeFindingEnqueueRows", () => {
  test("dry-run reports eligible rows without marking them enqueued", () => {
    const report = planVibeFindingEnqueueRows(
      [
        {
          id: "memory-1",
          sessionId: "session-1",
          content: [
            "USER: queue 復旧をしてください。provider failure と source_missing を分けてください。",
            "ASSISTANT: 原因を修正し、bunx vitest run test/queue-worker.test.ts が通りました。",
            "ASSISTANT: sqlite3 で finding_candidate_queue と distillation_queue_events を確認し、再発防止の手順を残しました。",
          ].join("\n\n"),
          metadata: { sourceId: "codex_logs", roles: ["user", "assistant"], chunkIndex: 1 },
          createdAt: new Date().toISOString(),
          agentDiffCount: 1,
        },
      ],
      { mode: "dry-run", limit: 10, minScore: 50, sinceDays: 7 },
    );

    expect(report.eligible).toBe(1);
    expect(report.enqueued).toBe(0);
    expect(report.items[0]).toMatchObject({
      vibeMemoryId: "memory-1",
      action: "would_enqueue",
      sourceId: "codex_logs",
    });
  });

  test("respects limit and reports rejected reasons", () => {
    const report = planVibeFindingEnqueueRows(
      [
        {
          id: "memory-1",
          sessionId: "session-1",
          content: "ASSISTANT: 確認します。",
          metadata: { sourceId: "codex_logs" },
          createdAt: new Date().toISOString(),
          agentDiffCount: 0,
        },
        {
          id: "memory-2",
          sessionId: "session-2",
          content: [
            "USER: provider failure を source_missing と分けてください。",
            "ASSISTANT: 原因を修正し、cargo test が通りました。",
            "ASSISTANT: queue worker の retry と completed outcome を確認し、復旧手順を記録しました。",
          ].join("\n\n"),
          metadata: { sourceId: "codex_logs", roles: ["user", "assistant"] },
          createdAt: new Date().toISOString(),
          agentDiffCount: 1,
        },
        {
          id: "memory-3",
          sessionId: "session-3",
          content: [
            "USER: DB queue の診断をしてください。",
            "ASSISTANT: sqlite3 で原因を確認し、verify が通りました。",
            "ASSISTANT: runtime owner と daemon heartbeat を確認して、再キュー条件を整理しました。",
          ].join("\n\n"),
          metadata: { sourceId: "codex_logs", roles: ["user", "assistant"] },
          createdAt: new Date().toISOString(),
          agentDiffCount: 1,
        },
      ],
      { mode: "dry-run", limit: 1, minScore: 50, sinceDays: 7 },
    );

    expect(report.eligible).toBe(1);
    expect(report.items.filter((item) => item.action === "would_enqueue")).toHaveLength(1);
    expect(report.items[0]?.action).toBe("rejected");
    expect(report.items[0]?.rejectReasons).toContain("progress_only");
  });

  test("parses sqlite unix-ms timestamps", () => {
    expect(parseVibeMemoryCreatedAt("unix-ms:1782735151897")).toBe(1782735151897);
    expect(parseVibeMemoryCreatedAt("2026-06-29T12:00:00.000Z")).toBe(
      Date.parse("2026-06-29T12:00:00.000Z"),
    );
  });

  test("applies since-days windows to sqlite unix-ms timestamps", () => {
    expect(isVibeMemoryWithinSinceDays(`unix-ms:${Date.now()}`, 1)).toBe(true);
    expect(isVibeMemoryWithinSinceDays(`unix-ms:${Date.now() - 3 * 24 * 60 * 60 * 1000}`, 1)).toBe(
      false,
    );
    expect(isVibeMemoryWithinSinceDays("not-a-date", 1)).toBe(true);
  });
});
