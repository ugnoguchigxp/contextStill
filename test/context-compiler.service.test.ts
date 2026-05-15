import { describe, expect, test, vi, beforeEach } from "vitest";
import { compileContextPack } from "../src/modules/context-compiler/context-compiler.service.js";
import * as knowledgeService from "../src/modules/knowledge/knowledge.service.js";
import * as sourceService from "../src/modules/sources/source-retrieval.service.js";
import * as repository from "../src/modules/context-compiler/context-compiler.repository.js";
import { config } from "../src/config.js";

vi.mock("../src/modules/knowledge/knowledge.service.js");
vi.mock("../src/modules/sources/source-retrieval.service.js");
vi.mock("../src/modules/context-compiler/context-compiler.repository.js");
vi.mock("../src/config.js", () => ({
  config: {
    defaultTokenBudget: 4000,
  },
}));

describe("context compiler service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("compileContextPack coordinates retrieval and ranking", async () => {
    vi.mocked(knowledgeService.retrieveKnowledge).mockResolvedValue({
      items: [
        {
          id: "k1",
          type: "rule",
          title: "Rule 1",
          body: "Rule body",
          score: 0.9,
          status: "active",
          confidence: 80,
          importance: 80,
          sourceRefs: [],
          hasSourceLinks: false,
        } as unknown as never,
      ],
      degradedReasons: [],
      stats: {} as unknown as never,
    });
    vi.mocked(sourceService.retrieveSources).mockResolvedValue({
      items: [
        {
          id: "s1",
          sourceUri: "wiki://1",
          locator: "L1",
          content: "Source content",
          score: 0.8,
        } as unknown as never,
      ],
      degradedReasons: [],
      stats: {} as unknown as never,
    });
    vi.mocked(repository.insertCompileRun).mockResolvedValue(
      "00000000-0000-0000-0000-000000000001",
    );

    const result = await compileContextPack({
      goal: "Implement a feature",
      intent: "edit",
    });

    expect(result.pack.runId).toBe("00000000-0000-0000-0000-000000000001");
    expect(result.pack.rules).toHaveLength(1);
    expect(result.pack.status).toBe("ok");
    expect(vi.mocked(repository.insertContextPackItems)).toHaveBeenCalled();
    expect(result.markdown).toContain("# Context Pack");
  });

  test("handles degraded state when retrieval returns reasons", async () => {
    vi.mocked(knowledgeService.retrieveKnowledge).mockResolvedValue({
      items: [],
      degradedReasons: ["NO_ACTIVE_KNOWLEDGE_MATCH"],
      stats: {} as unknown as never,
    });
    vi.mocked(sourceService.retrieveSources).mockResolvedValue({
      items: [],
      degradedReasons: ["NO_SOURCE_MATCH"],
      stats: {} as unknown as never,
    });
    vi.mocked(repository.insertCompileRun).mockResolvedValue(
      "00000000-0000-0000-0000-000000000002",
    );

    const result = await compileContextPack({
      goal: "Something unknown",
      intent: "edit",
    });

    expect(result.pack.status).toBe("degraded");
    expect(result.pack.diagnostics.degradedReasons).toContain("NO_ACTIVE_KNOWLEDGE_MATCH");
    expect(result.pack.warnings.some((w) => w.includes("search_knowledge"))).toBe(true);
  });

  test("resolves procedure_context for procedure-related goals", async () => {
    vi.mocked(knowledgeService.retrieveKnowledge).mockResolvedValue({
      items: [],
      degradedReasons: [],
      stats: {} as unknown as never,
    });
    vi.mocked(sourceService.retrieveSources).mockResolvedValue({
      items: [],
      degradedReasons: [],
      stats: {} as unknown as never,
    });
    vi.mocked(repository.insertCompileRun).mockResolvedValue(
      "00000000-0000-0000-0000-000000000003",
    );

    const result = await compileContextPack({
      goal: "Capture the 手順 for deploy",
      intent: "edit",
    });

    expect(result.pack.retrievalMode).toBe("procedure_context");
  });

  test("applies token budget constraints", async () => {
    const longBody = "x".repeat(10000);
    vi.mocked(knowledgeService.retrieveKnowledge).mockResolvedValue({
      items: [
        {
          id: "k1",
          type: "rule",
          title: "Rule 1",
          body: longBody,
          score: 0.9,
          status: "active",
          confidence: 80,
          importance: 80,
          sourceRefs: [],
          hasSourceLinks: false,
        } as unknown as never,
        {
          id: "k2",
          type: "rule",
          title: "Rule 2",
          body: "Rule 2 body",
          score: 0.8,
          status: "active",
          confidence: 80,
          importance: 80,
          sourceRefs: [],
          hasSourceLinks: false,
        } as unknown as never,
      ],
      degradedReasons: [],
      stats: {} as unknown as never,
    });
    vi.mocked(sourceService.retrieveSources).mockResolvedValue({
      items: [],
      degradedReasons: [],
      stats: {} as unknown as never,
    });
    vi.mocked(repository.insertCompileRun).mockResolvedValue(
      "00000000-0000-0000-0000-000000000004",
    );

    const result = await compileContextPack({
      goal: "test budget",
      intent: "edit",
      tokenBudget: 500,
    });

    expect(result.pack.rules).toHaveLength(1); // Second item should be dropped
    expect(result.pack.rules[0].content.length).toBeLessThan(longBody.length);
    expect(result.pack.diagnostics.degradedReasons).toContain("TOKEN_BUDGET_SECTION_LIMIT_REACHED");
  });
});
