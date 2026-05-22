import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../src/db/index.js";
import {
  findSourceFragmentByReference,
  selectKnowledgeByFinalizeSourceUri,
} from "../src/modules/finalizeDistille/repository.js";

const mockSelect = vi.fn();

vi.mock("../src/db/index.js", () => ({
  db: {
    select: (...args: any[]) => mockSelect(...args),
  },
}));

const makeChain = (result: any) => {
  const chain = {
    from: vi.fn().mockImplementation(() => chain),
    innerJoin: vi.fn().mockImplementation(() => chain),
    where: vi.fn().mockImplementation(() => chain),
    limit: vi.fn().mockImplementation(() => chain),
    then: (onfulfilled: any) => Promise.resolve(result).then(onfulfilled),
    catch: (onrejected: any) => Promise.resolve(result).catch(onrejected),
  };
  return chain;
};

describe("finalizeDistille repository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("selectKnowledgeByFinalizeSourceUri", () => {
    it("returns null if sourceUri is empty or whitespace", async () => {
      expect(await selectKnowledgeByFinalizeSourceUri("")).toBeNull();
      expect(await selectKnowledgeByFinalizeSourceUri("   ")).toBeNull();
    });

    it("returns row if query matches a record", async () => {
      const mockResult = [{ id: "k-123" }];
      mockSelect.mockReturnValueOnce(makeChain(mockResult));

      const result = await selectKnowledgeByFinalizeSourceUri("agent://my-source");
      expect(result).toEqual({ id: "k-123" });
      expect(mockSelect).toHaveBeenCalled();
    });

    it("returns null if no record matches", async () => {
      mockSelect.mockReturnValueOnce(makeChain([]));

      const result = await selectKnowledgeByFinalizeSourceUri("agent://my-source");
      expect(result).toBeNull();
    });
  });

  describe("findSourceFragmentByReference", () => {
    it("returns null if uri or locator is missing", async () => {
      expect(await findSourceFragmentByReference({ uri: "" })).toBeNull();
      expect(await findSourceFragmentByReference({ uri: "a", locator: "" })).toBeNull();
    });

    it("returns row if match found in inner joined tables", async () => {
      const mockResult = [{ sourceFragmentId: "frag-456" }];
      mockSelect.mockReturnValueOnce(makeChain(mockResult));

      const result = await findSourceFragmentByReference({ uri: "my-file.md", locator: "L10-20" });
      expect(result).toEqual({ sourceFragmentId: "frag-456" });
    });

    it("returns null if no match found", async () => {
      mockSelect.mockReturnValueOnce(makeChain([]));

      const result = await findSourceFragmentByReference({ uri: "my-file.md", locator: "L10-20" });
      expect(result).toBeNull();
    });
  });
});
