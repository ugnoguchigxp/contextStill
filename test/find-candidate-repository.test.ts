import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../src/db/index.js";
import {
  getFindCandidateResultById,
  insertFindCandidateResult,
  listFindCandidateResultsByTargetStateId,
} from "../src/modules/findCandidate/repository.js";

const mockSelect = vi.fn();
const mockInsert = vi.fn();

vi.mock("../src/db/index.js", () => ({
  db: {
    select: (...args: any[]) => mockSelect(...args),
    insert: (...args: any[]) => mockInsert(...args),
  },
}));

const makeChain = (result: any) => {
  const chain = {
    from: vi.fn().mockImplementation(() => chain),
    innerJoin: vi.fn().mockImplementation(() => chain),
    where: vi.fn().mockImplementation(() => chain),
    orderBy: vi.fn().mockImplementation(() => chain),
    limit: vi.fn().mockImplementation(() => chain),
    values: vi.fn().mockImplementation(() => chain),
    returning: vi.fn().mockResolvedValue(result),
    then: (onfulfilled: any) => Promise.resolve(result).then(onfulfilled),
    catch: (onrejected: any) => Promise.resolve(result).catch(onrejected),
  };
  return chain;
};

describe("findCandidate repository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getFindCandidateResultById", () => {
    it("returns null if query returns no row", async () => {
      mockSelect.mockReturnValueOnce(makeChain([]));

      const result = await getFindCandidateResultById("non-existent-id");
      expect(result).toBeNull();
    });

    it("returns mapped row if match found", async () => {
      const mockRow = {
        id: "c-1",
        targetStateId: "t-1",
        candidateIndex: 0,
        title: "Test Rule",
        content: "Rule Body",
        origin: {},
        status: "selected",
        createdAt: new Date(),
        updatedAt: new Date(),
        targetKind: "knowledge_candidate",
        targetKey: "k-key",
        sourceUri: "agent://source",
      };
      mockSelect.mockReturnValueOnce(makeChain([mockRow]));

      const result = await getFindCandidateResultById("c-1");
      expect(result).toEqual(mockRow);
    });
  });

  describe("listFindCandidateResultsByTargetStateId", () => {
    it("returns mapped list of rows", async () => {
      const mockRows = [
        {
          id: "c-1",
          targetStateId: "t-1",
          candidateIndex: 0,
          title: "Test Rule 1",
          content: "Body 1",
          origin: {},
          status: "selected",
          createdAt: new Date(),
          updatedAt: new Date(),
          targetKind: "knowledge_candidate",
          targetKey: "k-key-1",
          sourceUri: "agent://source-1",
        },
      ];
      mockSelect.mockReturnValueOnce(makeChain(mockRows));

      const result = await listFindCandidateResultsByTargetStateId("t-1");
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("c-1");
    });
  });

  describe("insertFindCandidateResult", () => {
    it("saves and returns inserted row on success", async () => {
      const mockInserted = { id: "new-c-1", title: "New Candidate" };
      mockInsert.mockReturnValueOnce(makeChain([mockInserted]));

      const result = await insertFindCandidateResult({
        targetStateId: "t-1",
        candidateIndex: 1,
        candidate: { title: "New Candidate", content: "Body Content", type: "rule" },
        origin: { readRanges: [] },
      });

      expect(result).toEqual(mockInserted);
      expect(mockInsert).toHaveBeenCalled();
    });

    it("throws error if database insert fails or returning empty list", async () => {
      mockInsert.mockReturnValueOnce(makeChain([])); // Nothing returned

      await expect(
        insertFindCandidateResult({
          targetStateId: "t-1",
          candidateIndex: 1,
          candidate: { title: "New Candidate", content: "Body Content", type: "rule" },
          origin: { readRanges: [] },
        }),
      ).rejects.toThrow("failed to save find_candidate_results row");
    });
  });
});
