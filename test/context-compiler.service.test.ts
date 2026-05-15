import { describe, expect, test, vi, beforeEach } from "vitest";
import { compileContextPack } from "../src/modules/context-compiler/context-compiler.service.js";
import { retrieveKnowledge } from "../src/modules/knowledge/knowledge.service.js";
import { retrieveSources } from "../src/modules/sources/source-retrieval.service.js";
import {
  insertCompileRun,
  insertContextPackItems,
} from "../src/modules/context-compiler/context-compiler.repository.js";

vi.mock("../src/modules/knowledge/knowledge.service.js");
vi.mock("../src/modules/sources/source-retrieval.service.js");
vi.mock("../src/modules/context-compiler/context-compiler.repository.js");
vi.mock("../src/modules/context-compiler/pack-renderer.js", () => ({
  renderContextPackMarkdown: vi.fn(() => "# Pack Content"),
}));

describe("Context Compiler Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(insertCompileRun).mockResolvedValue("550e8400-e29b-41d4-a716-446655440000");
  });

  test("compiles a basic pack and resolves procedure mode by keyword", async () => {
    vi.mocked(retrieveKnowledge).mockResolvedValue({
      items: [
        {
          id: "k1",
          type: "procedure",
          status: "active",
          title: "P1",
          body: "Body",
          score: 0.9,
          sourceRefs: [],
          hasSourceLinks: false,
        },
      ],
      degradedReasons: [],
      stats: { textHits: 1, vectorHits: 0, finalCount: 1 },
    } as any);
    vi.mocked(retrieveSources).mockResolvedValue({
      items: [],
      degradedReasons: [],
      stats: { hitCount: 0 },
    } as any);

    const { pack } = await compileContextPack({
      goal: "How to run the 手順?", // Trigger procedure_context
      intent: "edit",
      repoPath: "/test",
    });

    expect(pack.retrievalMode).toBe("procedure_context");
    expect(pack.procedures).toHaveLength(1);
    expect(insertCompileRun).toHaveBeenCalled();
  });

  test("applies token budget truncation for rules", async () => {
    vi.mocked(retrieveKnowledge).mockResolvedValue({
      items: [
        {
          id: "k1",
          type: "rule",
          status: "active",
          title: "Rule 1",
          body: "Long content ".repeat(200),
          score: 0.9,
          sourceRefs: [],
          hasSourceLinks: false,
        },
        {
          id: "k2",
          type: "rule",
          status: "active",
          title: "Rule 2",
          body: "More content",
          score: 0.8,
          sourceRefs: [],
          hasSourceLinks: false,
        },
      ],
      degradedReasons: [],
      stats: { textHits: 2, vectorHits: 0, finalCount: 2 },
    } as any);
    vi.mocked(retrieveSources).mockResolvedValue({
      items: [],
      degradedReasons: [],
      stats: { hitCount: 0 },
    } as any);

    const { pack } = await compileContextPack({
      goal: "test",
      intent: "plan",
      tokenBudget: 300,
    });

    expect(pack.rules).toHaveLength(1); // Second one dropped
    expect(pack.diagnostics.degradedReasons).toContain("TOKEN_BUDGET_SECTION_LIMIT_REACHED");
  });

  test("builds fallback source ref when no sources match", async () => {
    vi.mocked(retrieveKnowledge).mockResolvedValue({
      items: [],
      degradedReasons: ["NO_ACTIVE_KNOWLEDGE_MATCH"],
      stats: { textHits: 0, vectorHits: 0, finalCount: 0 },
    } as any);
    vi.mocked(retrieveSources).mockResolvedValue({
      items: [],
      degradedReasons: ["NO_SOURCE_MATCH"],
      stats: { hitCount: 0 },
    } as any);

    const { pack } = await compileContextPack({
      goal: "test",
      intent: "debug",
    });

    expect(pack.sourceRefs[0]).toContain(
      "550e8400-e29b-41d4-a716-446655440000#debug_context:NO_ACTIVE_KNOWLEDGE_MATCH",
    );
    expect(pack.status).toBe("degraded");
  });

  test("resolves retrieval mode based on intent", async () => {
    vi.mocked(retrieveKnowledge).mockResolvedValue({
      items: [],
      degradedReasons: [],
      stats: {},
    } as any);
    vi.mocked(retrieveSources).mockResolvedValue({
      items: [],
      degradedReasons: [],
      stats: {},
    } as any);

    const { pack: pack1 } = await compileContextPack({ goal: "fix bug", intent: "debug" });
    expect(pack1.retrievalMode).toBe("debug_context");

    const { pack: pack2 } = await compileContextPack({ goal: "review changes", intent: "review" });
    expect(pack2.retrievalMode).toBe("review_context");
  });

  test("ranks and dedupes items in the pack", async () => {
    vi.mocked(retrieveKnowledge).mockResolvedValue({
      items: [
        {
          id: "k1",
          type: "rule",
          status: "active",
          title: "R1",
          body: "...",
          score: 0.5,
          importance: 100,
          sourceRefs: [],
          hasSourceLinks: true,
        },
        {
          id: "k1",
          type: "rule",
          status: "active",
          title: "R1 Dup",
          body: "...",
          score: 0.4,
          importance: 50,
          sourceRefs: [],
          hasSourceLinks: false,
        },
      ],
      degradedReasons: [],
      stats: {},
    } as any);
    vi.mocked(retrieveSources).mockResolvedValue({
      items: [],
      degradedReasons: [],
      stats: {},
    } as any);

    const { pack } = await compileContextPack({ goal: "test", intent: "plan" });
    expect(pack.rules).toHaveLength(1);
    expect(pack.rules[0].id).toBe("knowledge:k1");
  });

  test("generates code context items from file hints", async () => {
    vi.mocked(retrieveKnowledge).mockResolvedValue({
      items: [],
      degradedReasons: [],
      stats: {},
    } as any);
    vi.mocked(retrieveSources).mockResolvedValue({
      items: [],
      degradedReasons: [],
      stats: {},
    } as any);

    const { pack } = await compileContextPack({
      goal: "test",
      intent: "plan",
      files: ["src/index.ts", "src/utils.ts"],
    });

    expect(pack.codeContext).toHaveLength(2);
    expect(pack.codeContext[0].title).toBe("src/index.ts");
  });

  test("returns default tasks for unknown retrieval modes", async () => {
    // This is hard to trigger via compileContextPack because schemas validate intents,
    // but we can test the internal buildMinimalTasks if we could.
    // For now, let's just cover the procedure_context tasks.
    vi.mocked(retrieveKnowledge).mockResolvedValue({
      items: [],
      degradedReasons: [],
      stats: {},
    } as any);
    vi.mocked(retrieveSources).mockResolvedValue({
      items: [],
      degradedReasons: [],
      stats: {},
    } as any);

    const { pack } = await compileContextPack({
      goal: "run a procedure",
      intent: "plan",
    });

    expect(pack.retrievalMode).toBe("procedure_context");
    expect(pack.minimalTasks[0]).toContain("Inspect the selected procedure candidates");
  });

  test("adds source recovery commands to suggestedNextCalls on source miss", async () => {
    vi.mocked(retrieveKnowledge).mockResolvedValue({
      items: [],
      degradedReasons: ["NO_ACTIVE_KNOWLEDGE_MATCH"],
      stats: {
        textHitCount: 0,
        vectorHitCount: 0,
        mergedCount: 0,
        textFailed: false,
        vectorFailed: false,
        embeddingStatus: "generated",
        scopedSearch: false,
        repoScopeFallbackUsed: false,
        queryText: "goal",
      },
    } as any);
    vi.mocked(retrieveSources).mockResolvedValue({
      items: [],
      degradedReasons: ["NO_SOURCE_MATCH"],
      stats: { hitCount: 0 },
    } as any);

    const { pack } = await compileContextPack({
      goal: "recover source context",
      intent: "debug",
    });
    const calls = (pack.diagnostics.retrievalStats.suggestedNextCalls ?? []) as string[];
    expect(calls).toContain("search_knowledge");
    expect(calls).toContain("memory_search");
    expect(calls).toContain("bun run import:sources -- <wiki root>");
    expect(calls).toContain("bun run distill:sources -- --apply");
  });

  test("boosts ranking with error context keyword and file matches", async () => {
    vi.mocked(retrieveKnowledge).mockResolvedValue({
      items: [
        {
          id: "k-strong",
          type: "rule",
          status: "active",
          title: "Type mismatch fix for src/auth/login.ts",
          body: "Handle not assignable type in login flow.",
          score: 0.6,
          sourceRefs: [],
          hasSourceLinks: false,
        },
        {
          id: "k-weak",
          type: "rule",
          status: "active",
          title: "General clean code guidance",
          body: "Keep functions small and readable.",
          score: 0.6,
          sourceRefs: [],
          hasSourceLinks: false,
        },
      ],
      degradedReasons: [],
      stats: {
        textHitCount: 2,
        vectorHitCount: 0,
        mergedCount: 2,
        textFailed: false,
        vectorFailed: false,
        embeddingStatus: "generated",
        scopedSearch: false,
        repoScopeFallbackUsed: false,
        queryText: "goal",
      },
    } as any);
    vi.mocked(retrieveSources).mockResolvedValue({
      items: [],
      degradedReasons: [],
      stats: { hitCount: 0 },
    } as any);

    const { pack } = await compileContextPack({
      goal: "fix compile error",
      intent: "debug",
      errorKind: "typecheck",
      lastErrorContext: {
        output: "Type 'Foo' is not assignable to type 'Bar'",
        files: ["src/auth/login.ts"],
      },
    });

    expect(pack.rules[0]?.id).toBe("knowledge:k-strong");
  });
});
