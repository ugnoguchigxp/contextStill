import { describe, expect, test, vi, beforeEach } from "vitest";
import {
  distillSources,
  buildSourceDistillationMessages,
  buildSourceDistillationInputHash,
} from "../src/modules/sources/distillation.service.js";
import * as repository from "../src/modules/sources/distillation.repository.js";
import * as knowledgeRepo from "../src/modules/knowledge/knowledge.repository.js";
import * as candidatesUtil from "../src/modules/distillation/distillation-candidates.js";
import * as promptsUtil from "../src/modules/distillation/distillation-prompts.js";
import * as runtime from "../src/modules/distillation/distillation-runtime.service.js";
import * as embedding from "../src/modules/embedding/embedding.service.js";
import { config } from "../src/config.js";

vi.mock("../src/modules/sources/distillation.repository.js");
vi.mock("../src/modules/knowledge/knowledge.repository.js");
vi.mock("../src/modules/distillation/distillation-candidates.js");
vi.mock("../src/modules/distillation/distillation-prompts.js");
vi.mock("../src/modules/distillation/distillation-runtime.service.js");
vi.mock("../src/modules/embedding/embedding.service.js");
vi.mock("../src/config.js", () => ({
  config: {
    sourceDistillationBatchSize: 5,
    sourceDistillationPromptVersion: "v1",
    localLlmModel: "test-model",
    sourceDistillationMaxInputChars: 1000,
    sourceDistillationMaxOutputTokens: 500,
  },
}));

describe("sources distillation service", () => {
  const mockFragment = {
    id: "f1",
    sourceId: "s1",
    sourceKind: "wiki" as const,
    sourceUri: "wiki://test",
    sourceTitle: "Test Wiki",
    sourceContentHash: "hash1",
    locator: "L1",
    heading: "H1",
    content: "Content of the wiki page",
    sourceMetadata: { repoPath: "/test/repo" },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(repository.listSourceFragmentsForDistillation).mockResolvedValue([
      mockFragment as unknown as never,
    ]);
    vi.mocked(promptsUtil.buildDistillationSystemPrompt).mockReturnValue("system prompt");
    vi.mocked(candidatesUtil.parseDistillationCandidateList).mockReturnValue([]);
    vi.mocked(candidatesUtil.filterDistillationCandidatesByScore).mockReturnValue({
      accepted: [],
      rejectedLowScore: [],
      rejectedInvalidEvidence: [],
      threshold: 0.5,
    });
  });

  describe("buildSourceDistillationMessages", () => {
    test("builds system and user messages", () => {
      const messages = buildSourceDistillationMessages({
        fragment: mockFragment as unknown as never,
      });
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe("system");
      expect(messages[1].role).toBe("user");
      expect(messages[1].content).toContain("wiki://test");
    });
  });

  describe("buildSourceDistillationInputHash", () => {
    test("returns a stable hash", () => {
      const hash1 = buildSourceDistillationInputHash(mockFragment as unknown as never);
      const hash2 = buildSourceDistillationInputHash(mockFragment as unknown as never);
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64);
    });
  });

  describe("distillSources", () => {
    test("processes fragments and returns summary (dry run)", async () => {
      const mockCompletion = {
        content: '{"candidates":[]}',
        toolEvents: [],
        messages: [],
      };
      vi.mocked(runtime.callLocalLlmCompletionForDistillation).mockResolvedValue(mockCompletion);

      const summary = await distillSources({ apply: false });

      expect(summary.processed).toBe(1);
      expect(summary.apply).toBe(false);
      expect(repository.upsertSourceDistillationRun).not.toHaveBeenCalled();
    });

    test("applies distillation and records results", async () => {
      const mockCandidate = {
        type: "rule" as const,
        title: "Rule 1",
        body: "Do something",
        confidence: 80,
        importance: 80,
        score: 0.9,
      };
      const mockCompletion = {
        content: '{"candidates":[...]}',
        toolEvents: [],
        messages: [],
      };

      vi.mocked(runtime.callLocalLlmCompletionForDistillation).mockResolvedValue(mockCompletion);
      vi.mocked(candidatesUtil.parseDistillationCandidateList).mockReturnValue([mockCandidate]);
      vi.mocked(candidatesUtil.filterDistillationCandidatesByScore).mockReturnValue({
        accepted: [mockCandidate],
        rejectedLowScore: [],
        rejectedInvalidEvidence: [],
        threshold: 0.5,
      });
      vi.mocked(embedding.embedOne).mockResolvedValue([0.1, 0.2]);
      vi.mocked(knowledgeRepo.upsertKnowledgeFromSource).mockResolvedValue("k1");
      vi.mocked(repository.upsertSourceDistillationRun).mockResolvedValue({
        id: "run1",
      } as unknown as never);

      const summary = await distillSources({ apply: true });

      expect(summary.knowledgeCount).toBe(1);
      expect(knowledgeRepo.upsertKnowledgeFromSource).toHaveBeenCalled();
      expect(repository.linkKnowledgeToSourceFragment).toHaveBeenCalledWith(
        expect.objectContaining({ knowledgeId: "k1", sourceFragmentId: "f1" }),
      );
      expect(repository.upsertSourceDistillationRun).toHaveBeenCalled();
    });

    test("handles errors for individual fragments", async () => {
      vi.mocked(runtime.callLocalLlmCompletionForDistillation).mockRejectedValue(
        new Error("LLM failure"),
      );
      vi.mocked(repository.upsertSourceDistillationRun).mockResolvedValue({
        id: "run-failed",
      } as unknown as never);

      const summary = await distillSources({ apply: true });

      expect(summary.failed).toBe(1);
      expect(summary.ok).toBe(false);
      expect(repository.upsertSourceDistillationRun).toHaveBeenCalledWith(
        expect.objectContaining({ status: "failed", error: "LLM failure" }),
      );
    });

    test("repairs invalid JSON if initial parse fails", async () => {
      const mockCompletion = { content: "invalid json", toolEvents: [], messages: [] };
      const mockRepairCompletion = { content: '{"candidates":[]}', toolEvents: [], messages: [] };

      vi.mocked(runtime.callLocalLlmCompletionForDistillation).mockResolvedValueOnce(
        mockCompletion,
      );
      vi.mocked(candidatesUtil.parseDistillationCandidateList)
        .mockImplementationOnce(() => {
          throw new Error("JSON parse error");
        })
        .mockReturnValueOnce([]); // Repaired

      const mockModelClient = vi.fn().mockResolvedValue(mockRepairCompletion);

      await distillSources({ apply: false, modelClient: mockModelClient });

      expect(mockModelClient).toHaveBeenCalledTimes(2); // Initial + Repair
    });
  });
});
