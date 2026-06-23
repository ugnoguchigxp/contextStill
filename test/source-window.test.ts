import { describe, expect, test } from "vitest";
import {
  buildBoundedSourceWindows,
  deterministicSemanticChunksFromWindows,
  validateSemanticChunks,
} from "../src/modules/distillation/source-window.js";

describe("source window semantic chunks", () => {
  test("builds bounded windows and deterministic chunk fallback", () => {
    const content = "x".repeat(3000);
    const windows = buildBoundedSourceWindows({
      content,
      maxTokens: 256,
      events: [
        { id: "event-1", startOffset: 0, endOffset: 900, createdAt: "2026-06-23T00:00:00Z" },
        {
          id: "event-2",
          startOffset: 900,
          endOffset: 1800,
          createdAt: "2026-06-23T00:01:00Z",
        },
        {
          id: "event-3",
          startOffset: 1800,
          endOffset: 3000,
          createdAt: "2026-06-23T00:02:00Z",
        },
      ],
    });

    expect(windows.length).toBeGreaterThan(1);
    expect(windows[0]?.sourceEndOffset).toBeLessThanOrEqual(1024);

    const chunks = deterministicSemanticChunksFromWindows(windows);
    expect(chunks).toHaveLength(windows.length);
    expect(chunks[0]).toMatchObject({
      chunkIndex: 0,
      expectedOutputs: ["both"],
    });
  });

  test("validates chunk offsets against source windows", () => {
    const windows = buildBoundedSourceWindows({
      content: "valid source text",
      events: [{ id: "event-1", startOffset: 0, endOffset: 17, createdAt: "2026-06-23T00:00:00Z" }],
    });

    const chunks = validateSemanticChunks({
      windows,
      chunks: {
        chunks: [
          {
            chunkIndex: 99,
            sourceStartOffset: 0,
            sourceEndOffset: 5,
            eventIds: ["event-1"],
            taskBoundaryKind: "investigation",
            title: "Valid chunk",
            boundaryReason: "Small source window.",
            expectedOutputs: ["candidate", "candidate"],
            openBoundary: false,
          },
          {
            chunkIndex: 1,
            sourceStartOffset: 0,
            sourceEndOffset: 500,
            eventIds: ["event-1"],
            taskBoundaryKind: "misc",
            title: "Invalid chunk",
            boundaryReason: "Outside the window.",
            expectedOutputs: ["candidate"],
            openBoundary: false,
          },
        ],
      },
    });

    expect(chunks).toEqual([
      expect.objectContaining({
        chunkIndex: 0,
        sourceStartOffset: 0,
        sourceEndOffset: 5,
        expectedOutputs: ["candidate"],
      }),
    ]);
  });

  test("does not split source windows inside a UTF-8 character", () => {
    const content = `${"x".repeat(1023)}あtail`;
    const windows = buildBoundedSourceWindows({
      content,
      maxTokens: 256,
    });

    expect(windows[0]?.sourceEndOffset).toBe(1023);
    expect(windows[0]?.text).not.toContain("\uFFFD");
    expect(windows[1]?.text.startsWith("あ")).toBe(true);
    expect(windows[1]?.text).not.toContain("\uFFFD");
  });
});
