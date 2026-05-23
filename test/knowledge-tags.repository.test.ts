import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../src/db/index.js";
import {
  listKnowledgeTagDefinitions,
  upsertKnowledgeTagDefinitions,
} from "../src/modules/knowledge/knowledge-tags.repository.js";

const mockSelect = vi.fn();
const mockInsert = vi.fn();
const mockUpdate = vi.fn();

vi.mock("../src/db/index.js", () => {
  return {
    db: {
      select: (...args: any[]) => mockSelect(...args),
      insert: (...args: any[]) => mockInsert(...args),
      update: (...args: any[]) => mockUpdate(...args),
    },
  };
});

describe("Knowledge Tags Repository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const makeChain = (result: any) => {
    const chain = {
      from: vi.fn().mockImplementation(() => chain),
      where: vi.fn().mockImplementation(() => chain),
      orderBy: vi.fn().mockImplementation(() => chain),
      limit: vi.fn().mockImplementation(() => chain),
      then: (onfulfilled: any) => Promise.resolve(result).then(onfulfilled),
      catch: (onrejected: any) => Promise.resolve(result).catch(onrejected),
    };
    return chain;
  };

  describe("listKnowledgeTagDefinitions", () => {
    it("returns correctly mapped definitions", async () => {
      const mockRows = [
        {
          id: "1",
          kind: "technology",
          slug: "typescript",
          label: "TypeScript",
          description: "TS language",
          aliases: ["ts", "typescript-lang"],
          status: "active",
          sortOrder: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      mockSelect.mockReturnValue(makeChain(mockRows));

      const results = await listKnowledgeTagDefinitions();
      expect(results.length).toBe(1);
      expect(results[0].slug).toBe("typescript");
      expect(results[0].aliases).toEqual(["ts", "typescript-lang"]);
      expect(results[0].status).toBe("active");
    });

    it("handles fallback mapping for unexpected kinds and statuses", async () => {
      const mockRows = [
        {
          id: "2",
          kind: "invalid-kind",
          slug: "unknown-slug",
          label: "Unknown",
          description: null,
          aliases: null, // should fall back to empty array
          status: "invalid-status",
          sortOrder: 99,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      mockSelect.mockReturnValue(makeChain(mockRows));

      const results = await listKnowledgeTagDefinitions({
        kinds: ["technology"],
        statuses: ["active"],
      });

      expect(results[0].kind).toBe("technology"); // fallback to technology
      expect(results[0].status).toBe("active"); // fallback to active
      expect(results[0].aliases).toEqual([]);
    });
  });

  describe("upsertKnowledgeTagDefinitions", () => {
    it("returns 0 immediately if definitions are empty", async () => {
      const changed = await upsertKnowledgeTagDefinitions([]);
      expect(changed).toBe(0);
      expect(mockSelect).not.toHaveBeenCalled();
    });

    it("inserts new tag if it does not exist", async () => {
      // db.select yields empty array
      mockSelect.mockReturnValue(makeChain([]));

      const mockInsertChain = {
        values: vi.fn().mockResolvedValue([]),
      };
      mockInsert.mockReturnValue(mockInsertChain);

      const changed = await upsertKnowledgeTagDefinitions([
        {
          kind: "technology",
          slug: "rust",
          label: "Rust",
          description: "Rust language",
          aliases: ["rs"],
          status: "active",
          sortOrder: 10,
        },
      ]);

      expect(changed).toBe(1);
      expect(mockInsert).toHaveBeenCalled();
      expect(mockInsertChain.values).toHaveBeenCalledWith(
        expect.objectContaining({
          slug: "rust",
          label: "Rust",
        }),
      );
    });

    it("skips tag if slug is empty or whitespace", async () => {
      const changed = await upsertKnowledgeTagDefinitions([
        {
          kind: "technology",
          slug: "   ",
          label: "Empty",
        },
      ]);

      expect(changed).toBe(0);
      expect(mockSelect).not.toHaveBeenCalled();
    });

    it("skips updating existing tag if all values are identical", async () => {
      const existingRow = {
        id: "ex-1",
        label: "Rust",
        description: "Rust language",
        aliases: ["rs"],
        status: "active",
        sortOrder: 10,
      };

      // db.select returns the existing row
      mockSelect.mockReturnValue(makeChain([existingRow]));

      const changed = await upsertKnowledgeTagDefinitions([
        {
          kind: "technology",
          slug: "rust",
          label: "Rust",
          description: "Rust language",
          aliases: ["rs"],
          status: "active",
          sortOrder: 10,
        },
      ]);

      expect(changed).toBe(0);
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it("updates existing tag if description, label, aliases, status, or sortOrder is different", async () => {
      const existingRow = {
        id: "ex-1",
        label: "Rust",
        description: "Rust language",
        aliases: ["rs"],
        status: "active",
        sortOrder: 10,
      };

      // db.select returns the existing row
      mockSelect.mockReturnValue(makeChain([existingRow]));

      const mockUpdateChain = {
        set: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue([]),
      };
      mockUpdate.mockReturnValue(mockUpdateChain);

      const changed = await upsertKnowledgeTagDefinitions([
        {
          kind: "technology",
          slug: "rust",
          label: "Rust Updated", // changed label
          description: "Rust language",
          aliases: ["rs"],
          status: "active",
          sortOrder: 10,
        },
      ]);

      expect(changed).toBe(1);
      expect(mockUpdate).toHaveBeenCalled();
      expect(mockUpdateChain.set).toHaveBeenCalledWith(
        expect.objectContaining({
          label: "Rust Updated",
        }),
      );
    });
  });
});
