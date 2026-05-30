import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../src/db/index.js";
import {
  type CoverEvidenceResultRow,
  coverEvidenceResultFromRow,
  listCoverEvidenceResultsByTargetStateId,
  saveCoverEvidenceResult,
  selectCoverEvidenceResultById,
} from "../src/modules/coverEvidence/repository.js";

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
    innerJoin: vi.fn().mockImplementation(() => chain),
    orderBy: vi.fn().mockImplementation(() => chain),
    values: vi.fn().mockImplementation(() => chain),
    onConflictDoUpdate: vi.fn().mockImplementation(() => chain),
    returning: vi.fn().mockResolvedValue(result),
    then: (onfulfilled: any) => Promise.resolve(result).then(onfulfilled),
    catch: (onrejected: any) => Promise.resolve(result).catch(onrejected),
  };
  return chain;
};

describe("coverEvidence repository unit tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mockRow: CoverEvidenceResultRow = {
    id: "evidence-1",
    status: "knowledge_ready",
    stage: "final",
    type: "rule",
    title: "Test Rule",
    body: "This is a test rule description.",
    importance: 8,
    confidence: 9,
    appliesTo: {
      general: false,
      technologies: ["TypeScript"],
      changeTypes: ["refactoring"],
      domains: ["testing"],
      repoPath: "src/modules",
      repoKey: "core",
    },
    references: [{ type: "file", uri: "file:///a.ts" }],
    duplicateRefs: [],
    toolEvents: [],
    reason: "extracted successfully",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  describe("selectCoverEvidenceResultById", () => {
    it("returns row when found", async () => {
      mockSelect.mockReturnValueOnce(makeChain([mockRow]));

      const result = await selectCoverEvidenceResultById("evidence-1");
      expect(result).toEqual(mockRow);
      expect(mockSelect).toHaveBeenCalled();
    });

    it("returns null when not found", async () => {
      mockSelect.mockReturnValueOnce(makeChain([]));

      const result = await selectCoverEvidenceResultById("evidence-missing");
      expect(result).toBeNull();
    });
  });

  describe("listCoverEvidenceResultsByTargetStateId", () => {
    it("returns list of rows", async () => {
      mockSelect.mockReturnValueOnce(makeChain([mockRow]));

      const result = await listCoverEvidenceResultsByTargetStateId("target-state-1");
      expect(result).toEqual([mockRow]);
    });
  });

  describe("saveCoverEvidenceResult", () => {
    it("inserts or updates a row successfully", async () => {
      mockInsert.mockReturnValueOnce(makeChain([mockRow]));

      const input = {
        id: "evidence-1",
        result: {
          schemaVersion: 1 as const,
          status: "knowledge_ready" as const,
          stage: "final" as const,
          candidate: {
            type: "rule" as const,
            title: "Test Rule",
            body: "This is a test rule description.",
            importance: 8,
            confidence: 9,
            applicabilityGeneral: false,
            technologies: ["TypeScript"],
            changeTypes: ["refactoring"],
            domains: ["testing"],
            repoPath: "src/modules",
            repoKey: "core",
          },
          references: [
            {
              uri: "file:///a.ts",
              kind: "source" as const,
              note: "",
              evidenceRole: "supports_candidate" as const,
            },
          ],
          duplicateRefs: [],
          toolEvents: [],
          reason: "extracted successfully",
        },
      };

      const result = await saveCoverEvidenceResult(input);
      expect(result).toEqual(mockRow);
      expect(mockInsert).toHaveBeenCalled();
    });

    it("saves with minimal candidate fields", async () => {
      const minimalRow = {
        ...mockRow,
        type: null,
        title: null,
        body: null,
        importance: null,
        confidence: null,
        appliesTo: {},
      };
      mockInsert.mockReturnValueOnce(makeChain([minimalRow]));

      const result = await saveCoverEvidenceResult({
        id: "evidence-1",
        result: {
          schemaVersion: 1 as const,
          status: "knowledge_ready",
          stage: "final",
          candidate: null,
          references: [],
          duplicateRefs: [],
          toolEvents: [],
          reason: "",
        },
      });

      expect(result).toEqual(minimalRow);
    });

    it("throws error if returning fails", async () => {
      mockInsert.mockReturnValueOnce(makeChain([]));

      await expect(
        saveCoverEvidenceResult({
          id: "evidence-1",
          result: {
            schemaVersion: 1 as const,
            status: "knowledge_ready",
            stage: "final",
            candidate: null,
            references: [],
            duplicateRefs: [],
            toolEvents: [],
            reason: "",
          },
        }),
      ).rejects.toThrow("failed to save cover evidence result");
    });
  });

  describe("coverEvidenceResultFromRow", () => {
    it("parses row to domain structure correctly", () => {
      const result = coverEvidenceResultFromRow(mockRow);
      expect(result.status).toBe("knowledge_ready");
      expect(result.candidate?.type).toBe("rule");
      expect(result.candidate?.title).toBe("Test Rule");
      expect(result.candidate?.importance).toBe(8);
      expect(result.candidate?.applicabilityGeneral).toBe(false);
      expect(result.candidate?.technologies).toEqual(["TypeScript"]);
      expect(result.candidate?.changeTypes).toEqual(["refactoring"]);
      expect(result.candidate?.domains).toEqual(["testing"]);
      expect(result.candidate?.repoPath).toBe("src/modules");
      expect(result.candidate?.repoKey).toBe("core");
    });

    it("handles null candidates and malformed fields", () => {
      const emptyRow = {
        ...mockRow,
        type: null,
        title: null,
        body: null,
        importance: null,
        confidence: null,
        appliesTo: null,
        references: null,
        duplicateRefs: null,
        toolEvents: null,
      };

      const result = coverEvidenceResultFromRow(emptyRow);
      expect(result.candidate).toBeNull();
      expect(result.references).toEqual([]);
      expect(result.duplicateRefs).toEqual([]);
      expect(result.toolEvents).toEqual([]);
    });
  });
});
