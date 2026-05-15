import { describe, expect, test } from "vitest";
import type {
  AgentDiffEntryForDistillation,
  VibeMemoryForDistillation,
} from "../src/modules/vibe-memory/distillation.repository.js";
import {
  buildVibeMemoryDistillationMessages,
  buildVibeMemoryInputHash,
  filterDistillationCandidatesByScore,
  parseDistillationCandidates,
} from "../src/modules/vibe-memory/distillation.service.js";

function memory(overrides: Partial<VibeMemoryForDistillation> = {}): VibeMemoryForDistillation {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    sessionId: "session-a",
    content: "The project decided that generated knowledge must stay draft until reviewed.",
    memoryType: "chat",
    dedupeKey: null,
    embedding: null,
    metadata: {},
    createdAt: new Date("2026-05-15T00:00:00.000Z"),
    ...overrides,
  };
}

function diff(
  overrides: Partial<AgentDiffEntryForDistillation> = {},
): AgentDiffEntryForDistillation {
  return {
    id: "00000000-0000-4000-8000-000000000101",
    vibeMemoryId: "00000000-0000-4000-8000-000000000001",
    filePath: "src/example.ts",
    diffHunk: "@@ -1 +1 @@\n-old\n+new",
    changeType: "modify",
    language: "typescript",
    symbolName: "example",
    symbolKind: "function",
    signature: "function example(): void",
    startLine: 1,
    endLine: 3,
    metadata: {},
    createdAt: new Date("2026-05-15T00:00:01.000Z"),
    updatedAt: new Date("2026-05-15T00:00:01.000Z"),
    ...overrides,
  };
}

describe("vibe memory distillation", () => {
  test("parses strict JSON candidates and ignores unsupported types", () => {
    const candidates = parseDistillationCandidates(`
\`\`\`json
{
  "candidates": [
    {
      "type": "rule",
      "title": "Keep generated knowledge in draft",
      "body": "Knowledge distilled from chat should remain draft until a human reviews it.",
      "confidence": 120,
      "importance": -10,
      "score": 0.8,
      "sourceRefs": ["vibe-memory:test"]
    },
    {
      "type": "note",
      "title": "Ignored",
      "body": "Unsupported type"
    }
  ]
}
\`\`\`
`);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      type: "rule",
      title: "Keep generated knowledge in draft",
      confidence: 100,
      importance: 0,
      score: 0.8,
    });
  });

  test("caps parsed candidates to the distillation limit", () => {
    const candidates = parseDistillationCandidates(
      JSON.stringify({
        candidates: [
          {
            type: "rule",
            title: "One",
            body: "First reusable rule.",
            score: 0.9,
            sourceRefs: ["local"],
          },
          {
            type: "procedure",
            title: "Two",
            body: "Second reusable procedure.",
            score: 0.8,
            sourceRefs: ["local"],
          },
          {
            type: "rule",
            title: "Three",
            body: "Third reusable rule.",
            score: 0.7,
            sourceRefs: ["local"],
          },
        ],
      }),
    );

    expect(candidates).toHaveLength(2);
  });

  test("filters out low scoring candidates before knowledge registration", () => {
    const candidates = parseDistillationCandidates(
      JSON.stringify({
        candidates: [
          {
            type: "rule",
            title: "Weak",
            body: "This is too weak to preserve.",
            score: 0,
            sourceRefs: ["local"],
          },
          {
            type: "procedure",
            title: "Strong",
            body: "This is durable enough to preserve.",
            score: 1,
            sourceRefs: ["local"],
          },
        ],
      }),
    );
    const gate = filterDistillationCandidatesByScore(candidates);

    expect(gate.threshold).toBeGreaterThanOrEqual(0);
    expect(gate.accepted.map((candidate) => candidate.title)).toEqual(["Strong"]);
    expect(gate.rejectedLowScore.map((candidate) => candidate.title)).toEqual(["Weak"]);
  });

  test("builds a prompt constrained to rule and procedure knowledge", () => {
    const messages = buildVibeMemoryDistillationMessages({
      memory: memory(),
      diffEntries: [diff()],
      maxInputChars: 4000,
    });
    const prompt = messages.map((message) => message.content).join("\n");

    expect(prompt).toContain("Allowed knowledge types are exactly: rule, procedure");
    expect(prompt).toContain("Assign confidence and importance as 0 to 100 values");
    expect(prompt).toContain("score");
    expect(prompt).toContain("Only emit candidates whose score is at least");
    expect(prompt).toContain("Do not include below-threshold candidates");
    expect(prompt).toContain("AGENT_DIFF_ENTRIES");
    expect(prompt).not.toMatch(/\bfact\b/i);
    expect(prompt).not.toMatch(/\blesson\b/i);
  });

  test("input hash changes when agent diff evidence changes", () => {
    const base = buildVibeMemoryInputHash({ memory: memory(), diffEntries: [diff()] });
    const changed = buildVibeMemoryInputHash({
      memory: memory(),
      diffEntries: [diff({ diffHunk: "@@ -1 +1 @@\n-a\n+b" })],
    });

    expect(changed).not.toBe(base);
  });
});
