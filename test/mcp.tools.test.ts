import { describe, expect, test, vi, beforeEach } from "vitest";
import { memorySearchTool, memoryFetchTool } from "../src/mcp/tools/memory.tool.js";
import {
  listKnowledgeTool,
  registerKnowledgeTool,
  searchKnowledgeTool,
  updateKnowledgeTool,
} from "../src/mcp/tools/knowledge.tool.js";
import { contextCompileTool } from "../src/mcp/tools/context-compile.tool.js";
import { initialInstructionsTool, doctorTool } from "../src/mcp/tools/system.tool.js";
import { retrieveVibeMemoryContext } from "../src/modules/vibe-memory/vibe-memory.service.js";
import {
  searchKnowledgeCandidates,
  registerKnowledgeFromMarkdown,
} from "../src/modules/knowledge/knowledge.service.js";
import { compileContextPack } from "../src/modules/context-compiler/context-compiler.service.js";
import { runDoctor } from "../src/modules/doctor/doctor.service.js";
import { embedOne } from "../src/modules/embedding/embedding.service.js";
import { vectorSearchKnowledge } from "../src/modules/knowledge/knowledge.repository.js";
import {
  listKnowledgeItems,
  updateKnowledgeItem,
} from "../api/modules/knowledge/knowledge.repository.js";

const { mockDb } = vi.hoisted(() => {
  return {
    mockDb: {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockImplementation(() => {
        return Object.assign(Promise.resolve([]), {
          orderBy: vi.fn().mockResolvedValue([]),
          limit: vi.fn().mockResolvedValue([]),
        });
      }),
      limit: vi.fn().mockResolvedValue([]),
    },
  };
});

vi.mock("../src/modules/vibe-memory/vibe-memory.service.js");
vi.mock("../src/modules/knowledge/knowledge.service.js");
vi.mock("../src/modules/context-compiler/context-compiler.service.js");
vi.mock("../src/modules/doctor/doctor.service.js");
vi.mock("../src/modules/embedding/embedding.service.js");
vi.mock("../src/modules/knowledge/knowledge.repository.js");
vi.mock("../api/modules/knowledge/knowledge.repository.js");

vi.mock("../src/db/client.js", () => ({
  db: mockDb,
}));

describe("MCP Tools Handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("memory_search", () => {
    test("calls retrieveVibeMemoryContext and returns JSON", async () => {
      const mockResults = [{ id: "1", content: "test" }];
      vi.mocked(retrieveVibeMemoryContext).mockResolvedValue(mockResults as unknown as never);

      const response = await memorySearchTool.handler({ query: "test query", limit: 5 });

      expect(retrieveVibeMemoryContext).toHaveBeenCalledWith({
        query: "test query",
        limit: 5,
        sessionId: undefined,
      });
      expect(JSON.parse(response.content[0].text)).toEqual({ items: mockResults });
    });

    test("throws if query is missing", async () => {
      await expect(memorySearchTool.handler({})).rejects.toThrow();
    });
  });

  describe("memory_fetch", () => {
    test("fetches memory and its diffs", async () => {
      vi.mocked(mockDb.where).mockImplementationOnce(() => {
        return Promise.resolve([
          { id: "mem-1", content: "Memory content", sessionId: "session-1" },
        ]) as unknown as never;
      });
      vi.mocked(mockDb.where).mockImplementationOnce(() => {
        return Object.assign(Promise.resolve([{ id: "diff-1" }]), {
          orderBy: vi.fn().mockResolvedValue([{ id: "diff-1" }]),
        }) as unknown as never;
      });

      const response = await memoryFetchTool.handler({ id: "mem-1" });
      const data = JSON.parse(response.content[0].text);
      expect(data.id).toBe("mem-1");
      expect(data.agentDiffs).toBeDefined();
    });

    test("supports query-based slicing and maxChars", async () => {
      const longContent = `${"abc ".repeat(100)}TARGET_KEYWORD${" def".repeat(100)}`;
      vi.mocked(mockDb.where).mockResolvedValueOnce([
        { id: "mem-1", content: longContent },
      ] as unknown as never);
      vi.mocked(mockDb.where).mockImplementationOnce(() => {
        return Object.assign(Promise.resolve([]), {
          orderBy: vi.fn().mockResolvedValue([]),
        }) as unknown as never;
      });

      const response = await memoryFetchTool.handler({
        id: "mem-1",
        query: "TARGET_KEYWORD",
        maxChars: 100,
      });
      const data = JSON.parse(response.content[0].text);
      expect(data.content).toContain("TARGET_KEYWORD");
      expect(data.content.length).toBeLessThanOrEqual(100);
    });

    test("returns error if memory not found", async () => {
      vi.mocked(mockDb.where).mockResolvedValueOnce([] as unknown as never);
      const response = await memoryFetchTool.handler({ id: "non-existent" });
      expect(response.isError).toBe(true);
      expect(response.content[0].text).toBe("Memory not found.");
    });
  });

  describe("search_knowledge", () => {
    test("calls searchKnowledgeCandidates and returns ranked results", async () => {
      vi.mocked(searchKnowledgeCandidates).mockResolvedValue({
        items: [
          {
            id: "k1",
            body: "body 1",
            sourceRefs: [],
            status: "active",
            confidence: 80,
            importance: 80,
          },
        ],
        stats: { queryText: "test" },
        degradedReasons: [],
      } as unknown as never);

      const response = await searchKnowledgeTool.handler({ query: "test" });
      const data = JSON.parse(response.content[0].text);
      expect(data.items[0].id).toBe("k1");
    });
  });

  describe("register_knowledge", () => {
    test("registers knowledge after checking for duplicates", async () => {
      vi.mocked(embedOne).mockResolvedValue([0.1, 0.2]);
      vi.mocked(vectorSearchKnowledge).mockResolvedValue([]);
      vi.mocked(registerKnowledgeFromMarkdown).mockResolvedValue("new-id");

      const response = await registerKnowledgeTool.handler({
        title: "New Rule",
        body: "Detailed body of the rule",
        type: "rule",
      });

      expect(registerKnowledgeFromMarkdown).toHaveBeenCalled();
      expect(response.content[0].text).toContain("new-id");
    });

    test("skips registration if similar content exists", async () => {
      vi.mocked(embedOne).mockResolvedValue([0.1, 0.2]);
      vi.mocked(vectorSearchKnowledge).mockResolvedValue([
        { id: "existing", body: "Detailed body of the rule" } as unknown as never,
      ]);

      const response = await registerKnowledgeTool.handler({
        title: "Duplicate Rule",
        body: "Detailed body of the rule",
      });

      expect(registerKnowledgeFromMarkdown).not.toHaveBeenCalled();
      expect(response.content[0].text).toContain("Registration skipped");
    });
  });

  describe("list_knowledge", () => {
    test("lists knowledge with filters", async () => {
      vi.mocked(listKnowledgeItems).mockResolvedValue([
        {
          id: "k-1",
          title: "Rule",
          status: "draft",
        },
      ] as unknown as never);

      const response = await listKnowledgeTool.handler({ status: "draft", limit: 20 });
      const data = JSON.parse(response.content[0].text);
      expect(data.count).toBe(1);
      expect(data.items[0].id).toBe("k-1");
      expect(listKnowledgeItems).toHaveBeenCalledWith({
        status: "draft",
        limit: 20,
      });
    });
  });

  describe("update_knowledge", () => {
    test("updates knowledge with merged fields", async () => {
      vi.mocked(mockDb.where).mockImplementationOnce(() => {
        return {
          limit: vi.fn().mockResolvedValue([
            {
              id: "k-1",
              type: "rule",
              status: "draft",
              scope: "repo",
              title: "Old title",
              body: "Old body",
              confidence: 70,
              importance: 70,
              metadata: { a: 1 },
            },
          ]),
        } as unknown as never;
      });
      vi.mocked(updateKnowledgeItem).mockResolvedValue({ id: "k-1" } as unknown as never);

      const response = await updateKnowledgeTool.handler({
        id: "550e8400-e29b-41d4-a716-446655440000",
        status: "active",
        title: "New title",
        metadata: { b: 2 },
      });
      const data = JSON.parse(response.content[0].text);
      expect(data.id).toBe("550e8400-e29b-41d4-a716-446655440000");
      expect(data.status).toBe("active");
      expect(updateKnowledgeItem).toHaveBeenCalledWith(
        "550e8400-e29b-41d4-a716-446655440000",
        expect.objectContaining({
          status: "active",
          title: "New title",
          metadata: { a: 1, b: 2 },
        }),
      );
    });
  });

  describe("context_compile", () => {
    test("calls compileContextPack and returns markdown only", async () => {
      vi.mocked(compileContextPack).mockResolvedValue({
        pack: {
          rules: [{ id: "k1", itemKind: "rule", title: "r", content: "b", sourceRefs: [] }],
          procedures: [],
          warnings: [],
        },
        markdown: "# Context",
      } as unknown as never);

      const response = await contextCompileTool.handler({ goal: "test goal" });
      expect(response.content.length).toBe(1);
      expect(response.content[0].text).toBe("# Context");
    });

    test("does not crash when pack fields are partially missing", async () => {
      vi.mocked(compileContextPack).mockResolvedValue({
        pack: {
          rules: [{ id: "k1", itemKind: "rule", title: "r", content: "b", sourceRefs: [] }],
          procedures: [],
        },
        markdown: "# Context",
      } as unknown as never);

      const response = await contextCompileTool.handler({ goal: "test goal" });
      expect(response.content.length).toBe(1);
      expect(response.content[0].text).toBe("# Context");
    });

    test("returns markdown even when sections are empty", async () => {
      vi.mocked(compileContextPack).mockResolvedValue({
        pack: { rules: [], procedures: [], warnings: [] },
        markdown: "該当する knowledge はありません。",
      } as unknown as never);

      const response = await contextCompileTool.handler({ goal: "test goal" });
      expect(response.content).toEqual([
        { type: "text", text: "該当する knowledge はありません。" },
      ]);
    });
  });

  describe("system tools", () => {
    test("initial_instructions returns text", async () => {
      const response = await initialInstructionsTool.handler();
      expect(response.content[0].text).toContain("## 常用ルール");
    });

    test("doctor calls runDoctor and returns JSON", async () => {
      const mockReport = { ok: true, health: "good" };
      vi.mocked(runDoctor).mockResolvedValue(mockReport as unknown as never);

      const response = await doctorTool.handler();
      expect(JSON.parse(response.content[0].text)).toEqual(mockReport);
    });
  });
});
