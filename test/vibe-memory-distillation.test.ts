import { describe, expect, test, vi } from "vitest";
import * as embeddingService from "../src/modules/embedding/embedding.service.js";
import * as knowledgeRepo from "../src/modules/knowledge/knowledge.repository.js";
import type {
  AgentDiffEntryForDistillation,
  VibeMemoryForDistillation,
} from "../src/modules/vibe-memory/distillation.repository.js";
import * as distillationRepo from "../src/modules/vibe-memory/distillation.repository.js";
import {
  buildVibeMemoryDistillationMessages,
  buildVibeMemoryInputHash,
  distillVibeMemories,
  filterDistillationCandidatesByScore,
  parseDistillationCandidates,
} from "../src/modules/vibe-memory/distillation.service.js";

vi.mock("../src/modules/vibe-memory/distillation.repository.js", () => ({
  listVibeMemoriesForDistillation: vi.fn(),
  listAgentDiffEntriesForVibeMemories: vi.fn(),
  recordVibeMemoryDistillationState: vi.fn().mockResolvedValue(undefined),
  upsertVibeMemoryDistillationRun: vi.fn().mockResolvedValue({ id: "run-1" }),
}));
vi.mock("../src/modules/knowledge/knowledge.repository.js", () => ({
  upsertKnowledgeFromSource: vi.fn(),
}));
vi.mock("../src/modules/embedding/embedding.service.js", () => ({
  embedOne: vi.fn(),
}));

function mockResolvedValue<T>(fn: unknown, value: T): void {
  (fn as { mockResolvedValue(value: T): void }).mockResolvedValue(value);
}

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

  test("parses natural language candidate even when score is omitted", () => {
    const candidates = parseDistillationCandidates(
      "TYPE: rule\nTITLE: Keep verify scope focused\nBODY: Start with repo-local verify command before broad checks.",
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].type).toBe("rule");
    expect(candidates[0].title).toContain("Keep verify scope focused");
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

  test("rejects candidates when URL evidence is required but no tool fetch exists", () => {
    const candidates = parseDistillationCandidates(
      JSON.stringify({
        candidates: [
          {
            type: "rule",
            title: "External behavior rule",
            body: "Use latest public API behavior.",
            score: 0.95,
            evidenceRefs: ["https://example.com/spec"],
          },
        ],
      }),
    );
    const gate = filterDistillationCandidatesByScore(candidates, {
      requireFetchEvidenceForUrlInput: true,
      toolEvents: [],
    });

    expect(gate.accepted).toHaveLength(0);
    expect(gate.rejectedInvalidEvidence.map((candidate) => candidate.title)).toEqual([
      "External behavior rule",
    ]);
  });

  test("builds a prompt constrained to rule and procedure knowledge", () => {
    const messages = buildVibeMemoryDistillationMessages({
      memory: memory(),
      diffEntries: [diff()],
      maxInputChars: 4000,
    });
    const prompt = messages.map((message) => message.content).join("\n");

    expect(prompt).toContain("知識タイプは rule と procedure のみ");
    expect(prompt).toContain("confidence と importance は判断可能な場合のみ");
    expect(prompt).toContain("score");
    expect(prompt).toContain("score は 0 から 1 で付けるのが望ましい（省略可）");
    expect(prompt).toContain("出力形式は次のいずれかでよい");
    expect(prompt).toContain("自然言語: TYPE / TITLE / BODY / SCORE(任意)");
    expect(prompt).toContain("可能な限り日本語");
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

  test("distillVibeMemories orchestrates the full flow", async () => {
    mockResolvedValue(distillationRepo.listVibeMemoriesForDistillation, [memory()]);
    mockResolvedValue(distillationRepo.listAgentDiffEntriesForVibeMemories, [diff()]);
    mockResolvedValue(knowledgeRepo.upsertKnowledgeFromSource, "k-123");
    mockResolvedValue(embeddingService.embedOne, [0.1, 0.2]);

    const modelClient = async () => ({
      content: JSON.stringify({
        candidates: [
          {
            type: "rule",
            title: "Test",
            body: "Test body",
            score: 1.0,
            sourceRefs: ["local"],
          },
        ],
      }),
      toolEvents: [],
      messages: [],
    });

    const result = await distillVibeMemories({
      apply: true,
      modelClient: modelClient as unknown as never,
    });

    if (result.knowledgeCount === 0) {
      console.log("DEBUG: Result results:", JSON.stringify(result.results, null, 2));
    }

    expect(result.knowledgeCount).toBe(1);
    expect(result.results[0].vibeMemoryId).toBe(memory().id);
    expect(distillationRepo.upsertVibeMemoryDistillationRun).toHaveBeenCalled();
  });
});
