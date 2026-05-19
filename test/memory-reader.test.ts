if (typeof (globalThis as any).Bun === "undefined") {
  (globalThis as any).Bun = {
    markdown: {
      render: (markdown: string, callbacks: any) => {
        let result = markdown;
        result = result.replace(/^#\s+(.+)$/gm, (_, p1) =>
          callbacks.heading ? callbacks.heading(p1) : `${p1}\n\n`,
        );
        result = result.replace(/\*\*(.*?)\*\*/g, (_, p1) =>
          callbacks.strong ? callbacks.strong(p1) : p1,
        );
        return result;
      },
    },
  };
}

import { describe, expect, it } from "vitest";
import { buildVibeReaderContext } from "../src/modules/distillation/distillation-reader.service.js";
import { prepareMemoryReaderContent } from "../src/modules/memoryReader/domain.js";
import type {
  AgentDiffEntryForDistillation,
  VibeMemoryForDistillation,
} from "../src/modules/vibe-memory/distillation.repository.js";

describe("prepareMemoryReaderContent", () => {
  it("should compress memory text by stripping markdown, minifying, and deduping phrases", () => {
    const result = prepareMemoryReaderContent({
      text: "# Title\nsame phrase here。same phrase here。",
      mode: "compressed",
      contentKind: "memory",
    });

    expect(result).toBe("Title same phrase here");
  });

  it("should preserve diff syntax while compressing diff whitespace", () => {
    const result = prepareMemoryReaderContent({
      text: "+++ src/example.ts\nimport value from '../../lib/value.js'\n",
      mode: "compressed",
      contentKind: "diff",
    });

    expect(result).toContain("../../lib/value.js");
    expect(result).toContain("+++ src/example.ts");
  });

  it("should return original content unchanged in original mode", () => {
    const text = "# Title\n**important**\n";
    const result = prepareMemoryReaderContent({
      text,
      mode: "original",
      contentKind: "memory",
    });

    expect(result).toBe(text);
  });
});

describe("buildVibeReaderContext memoryReader integration", () => {
  const memory = {
    id: "memory-1",
    sessionId: "session-1",
    content: "Memory body",
    memoryType: "chat",
    dedupeKey: null,
    embedding: null,
    metadata: {},
    createdAt: new Date("2026-05-19T00:00:00.000Z"),
  } satisfies VibeMemoryForDistillation;

  const diffEntry = {
    id: "diff-1",
    vibeMemoryId: "memory-1",
    filePath: "src/example.ts",
    diffHunk: "+++ src/example.ts\n+const value = 1\n",
    changeType: "modify",
    language: "typescript",
    symbolName: null,
    symbolKind: null,
    signature: null,
    startLine: null,
    endLine: null,
    metadata: {},
    createdAt: new Date("2026-05-19T00:00:00.000Z"),
    updatedAt: new Date("2026-05-19T00:00:00.000Z"),
  } satisfies AgentDiffEntryForDistillation;

  it("should dedupe identical diff segments in compressed mode", () => {
    const context = buildVibeReaderContext({
      memory,
      diffEntries: [diffEntry, { ...diffEntry, id: "diff-2" }],
      apply: false,
      mode: "compressed",
    });

    expect(
      context.segments.filter((segment) => segment.metadata?.filePath === "src/example.ts"),
    ).toHaveLength(1);
  });

  it("should keep identical diff segments in original mode", () => {
    const context = buildVibeReaderContext({
      memory,
      diffEntries: [diffEntry, { ...diffEntry, id: "diff-2" }],
      apply: false,
      mode: "original",
    });

    expect(
      context.segments.filter((segment) => segment.metadata?.filePath === "src/example.ts"),
    ).toHaveLength(2);
  });
});
