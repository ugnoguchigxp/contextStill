import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  listKnowledgeItems,
  updateKnowledgeItem,
} from "../api/modules/knowledge/knowledge.repository.js";
import { contextCompileTool } from "../src/mcp/tools/context-compile.tool.js";
import {
  listKnowledgeTool,
  registerCandidateTool,
  registerCandidatesTool,
  searchKnowledgeTool,
  updateKnowledgeTool,
} from "../src/mcp/tools/knowledge.tool.js";
import {
  memoryFetchTool as fetchMemoryLegacyTool,
  fetchMemoryTool as fetchMemoryPrimaryTool,
  memorySearchTool as searchMemoryLegacyTool,
  searchMemoryTool as searchMemoryPrimaryTool,
} from "../src/mcp/tools/memory.tool.js";
import { doctorTool, initialInstructionsTool } from "../src/mcp/tools/system.tool.js";
import { compileContextPack } from "../src/modules/context-compiler/context-compiler.service.js";
import { runDoctor } from "../src/modules/doctor/doctor.service.js";
import { searchKnowledgeCandidates } from "../src/modules/knowledge/knowledge.service.js";
import { registerCandidate } from "../src/modules/registerCandidate/register-candidate.service.js";
import { registerCandidatesBulk } from "../src/modules/registerCandidate/register-candidate.service.js";
import { reloadRuntimeSettingsCache } from "../src/modules/settings/settings.service.js";
import { retrieveVibeMemoryContext } from "../src/modules/vibe-memory/vibe-memory.service.js";

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
vi.mock("../src/modules/registerCandidate/register-candidate.service.js");
vi.mock("../src/modules/settings/settings.service.js");
vi.mock("../api/modules/knowledge/knowledge.repository.js");

vi.mock("../src/db/client.js", () => ({
  db: mockDb,
}));

describe("MCP Tools Handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MEMORY_ROUTER_LANG = undefined;
    process.env.MEMORY_ROUTER_MCP_V2 = "1";
    vi.mocked(reloadRuntimeSettingsCache).mockResolvedValue();
    vi.mocked(mockDb.where).mockImplementation(() => {
      return Object.assign(Promise.resolve([]), {
        orderBy: vi.fn().mockResolvedValue([]),
        limit: vi.fn().mockResolvedValue([]),
      });
    });
  });

  describe("search_memory", () => {
    test("calls retrieveVibeMemoryContext and returns JSON", async () => {
      const mockResults = [{ id: "1", content: "first line\ndetail body", score: 0.9 }];
      vi.mocked(retrieveVibeMemoryContext).mockResolvedValue(mockResults as unknown as never);

      const response = await searchMemoryPrimaryTool.handler({ query: "test query", limit: 5 });
      const payload = JSON.parse(response.content[0].text);

      expect(retrieveVibeMemoryContext).toHaveBeenCalledWith({
        query: "test query",
        limit: 5,
        sessionId: undefined,
      });
      expect(payload.items[0].id).toBe("1");
      expect(payload.items[0].title).toBe("first line");
      expect(payload.items[0].content).toBeUndefined();
    });

    test("throws if query is missing", async () => {
      await expect(searchMemoryPrimaryTool.handler({})).rejects.toThrow();
    });

    test("returns contentPreview when includeContent=true", async () => {
      const mockResults = [{ id: "1", content: "hello world", score: 0.9 }];
      vi.mocked(retrieveVibeMemoryContext).mockResolvedValue(mockResults as unknown as never);

      const response = await searchMemoryPrimaryTool.handler({
        query: "test query",
        includeContent: true,
        previewChars: 5,
      });
      const payload = JSON.parse(response.content[0].text);
      expect(payload.items[0].contentPreview).toBe("hello");
      expect(payload.items[0].contentTruncated).toBe(true);
    });

    test("legacy alias memory_search points to the same handler", async () => {
      const mockResults = [{ id: "1", content: "test", score: 0.9 }];
      vi.mocked(retrieveVibeMemoryContext).mockResolvedValue(mockResults as unknown as never);

      const response = await searchMemoryLegacyTool.handler({ query: "test query" });
      const payload = JSON.parse(response.content[0].text);
      expect(payload.items[0].id).toBe("1");
    });
  });

  describe("fetch_memory", () => {
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

      const response = await fetchMemoryPrimaryTool.handler({
        id: "mem-1",
        includeAgentDiffs: true,
      });
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

      const response = await fetchMemoryPrimaryTool.handler({
        id: "mem-1",
        query: "TARGET_KEYWORD",
        maxChars: 100,
      });
      const data = JSON.parse(response.content[0].text);
      expect(data.content).toContain("TARGET_KEYWORD");
      expect(data.content.length).toBeLessThanOrEqual(100);
      expect(data.sliceStart).toBeTypeOf("number");
      expect(data.sliceEnd).toBeTypeOf("number");
    });

    test("returns error if memory not found", async () => {
      vi.mocked(mockDb.where).mockResolvedValueOnce([] as unknown as never);
      const response = await fetchMemoryPrimaryTool.handler({ id: "non-existent" });
      expect(response.isError).toBe(true);
      expect(response.content[0].text).toBe("Memory not found.");
    });

    test("supports returnMetaOnly", async () => {
      vi.mocked(mockDb.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            {
              id: "mem-1",
              content: "Memory content",
              sessionId: "session-1",
              memoryType: "chat",
            },
          ]),
        }),
      } as unknown as never);
      const response = await fetchMemoryPrimaryTool.handler({
        id: "mem-1",
        returnMetaOnly: true,
      });
      const data = JSON.parse(response.content[0].text);
      expect(data.id).toBe("mem-1");
      expect(data.content).toBeUndefined();
      expect(data.contentLength).toBeGreaterThan(0);
    });

    test("legacy alias memory_fetch points to the same handler", async () => {
      vi.mocked(mockDb.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            {
              id: "mem-1",
              content: "Memory content",
              sessionId: "session-1",
              memoryType: "chat",
            },
          ]),
        }),
      } as unknown as never);
      const response = await fetchMemoryLegacyTool.handler({ id: "mem-1" });
      const data = JSON.parse(response.content[0].text);
      expect(data.id).toBe("mem-1");
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

  describe("register_candidate", () => {
    test("registers a lightweight candidate without synchronous knowledge persistence", async () => {
      vi.mocked(registerCandidate).mockResolvedValue({
        targetStateId: "target-id",
        findCandidateResultId: "candidate-id",
        sourceUri: "agent://candidate/candidate-id",
        status: "candidate_registered",
        title: "New Rule",
        type: "rule",
        warnings: [],
        next: "distillation_pipeline",
      });

      const response = await registerCandidateTool.handler({
        title: "New Rule",
        body: "Detailed body of the rule",
        type: "rule",
      });

      expect(registerCandidate).toHaveBeenCalledWith({
        title: "New Rule",
        body: "Detailed body of the rule",
        type: "rule",
        metadata: {},
      });
      expect(JSON.parse(response.content[0].text)).toMatchObject({
        targetStateId: "target-id",
        findCandidateResultId: "candidate-id",
        status: "candidate_registered",
      });
    });

    test("accepts text-only candidate notes for normalization", async () => {
      vi.mocked(registerCandidate).mockResolvedValue({
        targetStateId: "target-id",
        findCandidateResultId: "candidate-id",
        sourceUri: "agent://candidate/candidate-id",
        status: "candidate_registered",
        title: "Failure note",
        type: "procedure",
        warnings: ["text_parsed_to_candidate_json"],
        next: "distillation_pipeline",
      });

      await registerCandidateTool.handler({
        text: '{"type":"procedure","title":"Failure note","body":"Use when:\\n- ..."}',
      });

      expect(registerCandidate).toHaveBeenCalledWith({
        text: '{"type":"procedure","title":"Failure note","body":"Use when:\\n- ..."}',
        metadata: {},
      });
    });
  });

  describe("register_candidates", () => {
    test("registers multiple candidates", async () => {
      vi.mocked(registerCandidatesBulk).mockResolvedValue({
        status: "bulk_candidates_registered",
        registeredCount: 2,
        failedCount: 0,
        items: [],
        next: "distillation_pipeline",
      } as never);

      const response = await registerCandidatesTool.handler({
        items: [{ body: "A" }, { body: "B" }],
      });
      const data = JSON.parse(response.content[0].text);
      expect(data.registeredCount).toBe(2);
      expect(registerCandidatesBulk).toHaveBeenCalled();
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
      vi.mocked(mockDb.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
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
          }),
        }),
      } as unknown as never);
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
      expect(reloadRuntimeSettingsCache).toHaveBeenCalledTimes(1);
      expect(vi.mocked(reloadRuntimeSettingsCache).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(compileContextPack).mock.invocationCallOrder[0],
      );
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
        markdown: "No Content",
      } as unknown as never);

      const response = await contextCompileTool.handler({ goal: "test goal" });
      expect(response.content).toEqual([{ type: "text", text: "No Content" }]);
    });
  });

  describe("system tools", () => {
    test("initial_instructions returns Japanese text by default", async () => {
      process.env.MEMORY_ROUTER_LANG = undefined;
      const response = await initialInstructionsTool.handler();
      expect(response.content[0].text).toContain("## 常用ルール");
    });

    test("initial_instructions returns English text when MEMORY_ROUTER_LANG=en", async () => {
      process.env.MEMORY_ROUTER_LANG = "en";
      const response = await initialInstructionsTool.handler();
      expect(response.content[0].text).toContain("## Core Rules");
    });

    test("doctor calls runDoctor and returns JSON", async () => {
      const mockReport = { ok: true, health: "good" };
      vi.mocked(runDoctor).mockResolvedValue(mockReport as unknown as never);

      const response = await doctorTool.handler();
      expect(JSON.parse(response.content[0].text)).toEqual(mockReport);
    });
  });
});
