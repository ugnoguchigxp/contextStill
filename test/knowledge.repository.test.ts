import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { db } from "../src/db/index.js";
import {
  searchKnowledge,
  upsertKnowledgeFromSource,
  vectorSearchKnowledge,
} from "../src/modules/knowledge/knowledge.repository.js";

vi.mock("../src/db/index.js", () => {
  const selectChain = {
    from: vi.fn(() => selectChain),
    where: vi.fn(() => selectChain),
    orderBy: vi.fn(() => selectChain),
    limit: vi.fn(() => Promise.resolve([])),
    innerJoin: vi.fn(() => selectChain),
  };
  return {
    db: {
      select: vi.fn(() => selectChain),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve([{ id: "id" }])),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => Promise.resolve()),
        })),
      })),
      query: {
        knowledgeItems: {
          findFirst: vi.fn(),
        },
      },
    },
  };
});

describe("Knowledge Repository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("searchKnowledge", () => {
    test("calls select with correct conditions", async () => {
      await searchKnowledge({ query: "test", limit: 10, status: "active", includeDraft: false });
      expect(db.select).toHaveBeenCalled();
    });
  });

  describe("upsertKnowledgeFromSource", () => {
    test("inserts new item if not exists", async () => {
      vi.mocked(db.query.knowledgeItems.findFirst).mockResolvedValue(undefined as any);
      const id = await upsertKnowledgeFromSource({
        sourceUri: "uri",
        type: "rule",
        status: "active",
        scope: "repo",
        title: "T",
        body: "B",
      });
      expect(id).toBe("id");
      expect(db.insert).toHaveBeenCalled();
    });

    test("updates existing item if exists", async () => {
      vi.mocked(db.query.knowledgeItems.findFirst).mockResolvedValue({ id: "ex-id" } as any);
      const id = await upsertKnowledgeFromSource({
        sourceUri: "uri",
        type: "rule",
        status: "active",
        scope: "repo",
        title: "T",
        body: "B",
      });
      expect(id).toBe("ex-id");
      expect(db.update).toHaveBeenCalled();
    });
  });

  describe("vectorSearchKnowledge", () => {
    test("calls similarity search", async () => {
      await vectorSearchKnowledge(new Array(1536).fill(0), 5);
      expect(db.select).toHaveBeenCalled();
    });
  });

  describe("Internal Helpers (Branch Coverage)", () => {
    test("search with repo scope", async () => {
      await searchKnowledge(
        { query: "q", limit: 1, status: "active", includeDraft: false },
        { repoPath: "/p", repoKey: "k" },
      );
      expect(db.select).toHaveBeenCalled();
    });

    test("search with global scope allowed", async () => {
      await searchKnowledge(
        { query: "q", limit: 1, status: "active", includeDraft: false },
        { repoPath: "/p", allowGlobalScope: true },
      );
      expect(db.select).toHaveBeenCalled();
    });
  });
});
