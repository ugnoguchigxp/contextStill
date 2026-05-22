import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../src/db/index.js";
import {
  findDistillationEvidenceCache,
  upsertDistillationEvidenceCache,
  evidenceCacheFreshAfter,
} from "../src/modules/distillation/distillation-evidence-cache.repository.js";

const mockSelect = vi.fn();
const mockInsert = vi.fn();

vi.mock("../src/db/index.js", () => {
  const mockDb = {
    select: (...args: any[]) => mockSelect(...args),
    insert: (...args: any[]) => mockInsert(...args),
  };
  return { db: mockDb };
});

const makeChain = (result: any) => {
  const chain = {
    from: vi.fn().mockImplementation(() => chain),
    where: vi.fn().mockImplementation(() => chain),
    limit: vi.fn().mockImplementation(() => chain),
    values: vi.fn().mockImplementation(() => chain),
    onConflictDoUpdate: vi.fn().mockImplementation(() => chain),
    then: (onfulfilled: any) => Promise.resolve(result).then(onfulfilled),
    catch: (onrejected: any) => Promise.resolve(result).catch(onrejected),
  };
  return chain;
};

describe("distillation-evidence-cache.repository unit tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mockRow = {
    id: "cache-1",
    toolName: "test-tool",
    queryText: "search query",
    url: "https://example.com",
    ok: 1,
    excerpt: "excerpt text",
    metadata: {},
    fetchedAt: new Date(),
    updatedAt: new Date(),
  };

  describe("findDistillationEvidenceCache", () => {
    it("returns cached row when found", async () => {
      mockSelect.mockReturnValueOnce(makeChain([mockRow]));

      const result = await findDistillationEvidenceCache({
        toolName: "test-tool",
        queryText: "search query",
        url: "https://example.com",
        freshAfter: new Date(),
      });

      expect(result).toEqual(mockRow);
      expect(mockSelect).toHaveBeenCalled();
    });

    it("returns cached row when url is missing", async () => {
      mockSelect.mockReturnValueOnce(makeChain([mockRow]));

      const result = await findDistillationEvidenceCache({
        toolName: "test-tool",
        queryText: "search query",
        freshAfter: new Date(),
      });

      expect(result).toEqual(mockRow);
    });

    it("returns null when not found", async () => {
      mockSelect.mockReturnValueOnce(makeChain([]));

      const result = await findDistillationEvidenceCache({
        toolName: "test-tool",
        queryText: "search query",
        freshAfter: new Date(),
      });

      expect(result).toBeNull();
    });
  });

  describe("upsertDistillationEvidenceCache", () => {
    it("upserts evidence cache successfully", async () => {
      mockInsert.mockReturnValueOnce(makeChain(undefined));

      await upsertDistillationEvidenceCache({
        toolName: "test-tool",
        queryText: "search query",
        url: "https://example.com",
        ok: true,
        excerpt: "new excerpt",
        metadata: { source: "test" },
      });

      expect(mockInsert).toHaveBeenCalled();
    });

    it("upserts evidence cache with default params", async () => {
      mockInsert.mockReturnValueOnce(makeChain(undefined));

      await upsertDistillationEvidenceCache({
        toolName: "test-tool",
        queryText: "search query",
        ok: false,
      });

      expect(mockInsert).toHaveBeenCalled();
    });
  });

  describe("evidenceCacheFreshAfter", () => {
    it("returns the correct Date for freshAfter based on TTL", () => {
      const now = Date.now();
      const result = evidenceCacheFreshAfter(300); // 5 mins

      expect(result.getTime()).toBeLessThanOrEqual(now - 300 * 1000 + 10);
      expect(result.getTime()).toBeGreaterThanOrEqual(now - 300 * 1000 - 10);
    });
  });
});
