import { beforeEach, describe, expect, test, vi } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { db } from "../src/db/index.js";
import { recordAuditLogSafe } from "../src/modules/audit/audit-log.service.js";
import {
  listDistillationTargetStatesForCandidates,
  upsertDistillationTargetState,
  markMissingVibeMemoryTargetsSkipped,
  markMissingWikiTargetsSkipped,
  findNextSelectableDistillationTargetState,
} from "../src/modules/selectDistillationTarget/repository.js";

const mocks = vi.hoisted(() => ({
  memories: [] as Array<{
    id: string;
    sessionId: string;
    content: string;
    memoryType: string;
    dedupeKey: string | null;
    embedding: null;
    metadata: Record<string, unknown>;
    createdAt: Date;
  }>,
  limit: vi.fn(),
}));

vi.mock("../src/db/index.js", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        orderBy: vi.fn(() => {
          const query = Promise.resolve(mocks.memories) as Promise<typeof mocks.memories> & {
            limit: (value: number) => Promise<typeof mocks.memories>;
          };
          query.limit = (value: number) => {
            mocks.limit(value);
            return Promise.resolve(mocks.memories.slice(0, value));
          };
          return query;
        }),
      })),
    })),
  },
}));

vi.mock("node:fs/promises", () => ({
  readdir: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock("../src/modules/audit/audit-log.service.js", () => ({
  auditEventTypes: {
    distillationTargetInventoryRefreshed: "DISTILLATION_TARGET_INVENTORY_REFRESHED",
  },
  recordAuditLogSafe: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/modules/selectDistillationTarget/repository.js", () => ({
  DEFAULT_DISTILLATION_TARGET_VERSION: "select-distillation-target-v1",
  listDistillationTargetStatesForCandidates: vi.fn(),
  upsertDistillationTargetState: vi.fn(),
  markMissingVibeMemoryTargetsSkipped: vi.fn(),
  markMissingWikiTargetsSkipped: vi.fn(),
  findNextSelectableDistillationTargetState: vi.fn(),
}));

function memory(id: string, createdAt: string) {
  return {
    id,
    sessionId: `session-${id}`,
    content: `memory ${id}`,
    memoryType: "chat",
    dedupeKey: null,
    embedding: null,
    metadata: {},
    createdAt: new Date(createdAt),
  };
}

describe("selectDistillationTarget inventory.service unit tests", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.memories = [
      memory("memory-1", "2026-05-17T00:00:00.000Z"),
      memory("memory-2", "2026-05-18T00:00:00.000Z"),
      memory("memory-3", "2026-05-19T00:00:00.000Z"),
    ];
  });

  describe("collectVibeMemoryTargetCandidates", () => {
    test("collects all vibe memories by default", async () => {
      const { collectVibeMemoryTargetCandidates } = await import(
        "../src/modules/selectDistillationTarget/inventory.service.js"
      );

      const candidates = await collectVibeMemoryTargetCandidates();

      expect(mocks.limit).not.toHaveBeenCalled();
      expect(candidates.map((candidate) => candidate.targetKey)).toEqual([
        "memory-1",
        "memory-2",
        "memory-3",
      ]);
    });

    test("honors explicit vibe inventory limits", async () => {
      const { collectVibeMemoryTargetCandidates } = await import(
        "../src/modules/selectDistillationTarget/inventory.service.js"
      );

      const candidates = await collectVibeMemoryTargetCandidates({ limit: 2 });

      expect(mocks.limit).toHaveBeenCalledWith(2);
      expect(candidates.map((candidate) => candidate.targetKey)).toEqual(["memory-1", "memory-2"]);
    });

    test("returns empty array on database error with missing relation", async () => {
      const { collectVibeMemoryTargetCandidates } = await import(
        "../src/modules/selectDistillationTarget/inventory.service.js"
      );

      const error = new Error("relation vibe_memories does not exist");
      (error as any).code = "42P01";
      vi.spyOn(db, "select").mockImplementationOnce(() => {
        throw error;
      });

      const candidates = await collectVibeMemoryTargetCandidates();
      expect(candidates).toEqual([]);
    });
  });

  describe("collectWikiFileTargetCandidates", () => {
    test("collects wiki files successfully", async () => {
      const { collectWikiFileTargetCandidates } = await import(
        "../src/modules/selectDistillationTarget/inventory.service.js"
      );

      vi.mocked(readdir).mockResolvedValueOnce([
        { isFile: () => true, name: "file1.md", parentPath: "/workspace/wiki" } as any,
        { isFile: () => true, name: "file2.txt", parentPath: "/workspace/wiki" } as any,
        { isFile: () => false, name: "folder1", parentPath: "/workspace/wiki" } as any,
      ]);
      vi.mocked(readFile).mockResolvedValueOnce("some content");

      const candidates = await collectWikiFileTargetCandidates({ rootPath: "/workspace/wiki" });

      expect(candidates.length).toBe(1);
      expect(candidates[0].targetKey).toBe("file1.md");
      expect(candidates[0].targetKind).toBe("wiki_file");
    });
  });

  describe("applyPersistedDistillationTargetStatuses", () => {
    test("maps persisted statuses correctly", async () => {
      const { applyPersistedDistillationTargetStatuses } = await import(
        "../src/modules/selectDistillationTarget/inventory.service.js"
      );

      const mockStates = [
        {
          targetKind: "wiki_file" as const,
          targetKey: "a.md",
          status: "completed" as const,
          sortKey: "a",
        } as any,
      ];
      vi.mocked(listDistillationTargetStatesForCandidates).mockResolvedValueOnce(mockStates);

      const candidates = [
        {
          targetKind: "wiki_file" as const,
          targetKey: "a.md",
          sourceUri: "a",
          status: "pending" as const,
        },
        {
          targetKind: "wiki_file" as const,
          targetKey: "b.md",
          sourceUri: "b",
          status: "pending" as const,
        },
      ];

      const result = await applyPersistedDistillationTargetStatuses({ candidates });
      expect(result[0].status).toBe("completed");
      expect(result[1].status).toBe("pending");
    });
  });

  describe("refreshDistillationTargetInventory", () => {
    test("refreshes inventory successfully", async () => {
      const { refreshDistillationTargetInventory } = await import(
        "../src/modules/selectDistillationTarget/inventory.service.js"
      );

      vi.mocked(readdir).mockResolvedValueOnce([
        { isFile: () => true, name: "file1.md", parentPath: "/workspace/wiki" } as any,
      ]);
      vi.mocked(readFile).mockResolvedValueOnce("some content");
      vi.mocked(markMissingWikiTargetsSkipped).mockResolvedValueOnce(0);
      vi.mocked(markMissingVibeMemoryTargetsSkipped).mockResolvedValueOnce(0);

      const result = await refreshDistillationTargetInventory({
        kind: "auto",
        rootPath: "/workspace/wiki",
      });

      expect(result.wikiTargets).toBe(1);
      expect(result.vibeMemoryTargets).toBe(3);
      expect(result.missingVibeMemoryTargetsSkipped).toBe(0);
      expect(upsertDistillationTargetState).toHaveBeenCalled();
      expect(recordAuditLogSafe).toHaveBeenCalled();
    });
  });

  describe("previewNextDistillationTarget", () => {
    test("previews from state table when requested", async () => {
      const { previewNextDistillationTarget } = await import(
        "../src/modules/selectDistillationTarget/inventory.service.js"
      );

      const mockState = {
        id: "t-1",
        targetKind: "wiki_file" as const,
        targetKey: "a.md",
        sourceUri: "a",
        status: "pending" as const,
      } as any;
      vi.mocked(findNextSelectableDistillationTargetState).mockResolvedValueOnce(mockState);

      const result = await previewNextDistillationTarget({ fromStateTable: true, kind: "wiki" });
      expect(result).not.toBeNull();
      expect(result?.targetKey).toBe("a.md");
    });

    test("previews candidate-first when kind = candidate", async () => {
      const { previewNextDistillationTarget } = await import(
        "../src/modules/selectDistillationTarget/inventory.service.js"
      );

      const mockState = {
        id: "t-1",
        targetKind: "knowledge_candidate" as const,
        targetKey: "c-1",
        sourceUri: "c",
        status: "pending" as const,
      } as any;
      vi.mocked(findNextSelectableDistillationTargetState).mockResolvedValueOnce(mockState);

      const result = await previewNextDistillationTarget({ kind: "candidate" });
      expect(result?.targetKey).toBe("c-1");
    });

    test("previews wiki-first on previewNextDistillationTarget", async () => {
      const { previewNextDistillationTarget } = await import(
        "../src/modules/selectDistillationTarget/inventory.service.js"
      );

      vi.mocked(readdir).mockResolvedValueOnce([
        { isFile: () => true, name: "file1.md", parentPath: "/workspace/wiki" } as any,
      ]);
      vi.mocked(readFile).mockResolvedValueOnce("some content");
      vi.mocked(listDistillationTargetStatesForCandidates).mockResolvedValueOnce([]);

      const result = await previewNextDistillationTarget({
        kind: "auto",
        rootPath: "/workspace/wiki",
      });
      expect(result?.targetKey).toBe("file1.md");
    });
  });
});
