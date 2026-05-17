import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { groupedConfig } from "../src/config.js";
import {
  buildSourceDistillationInputHash,
  buildSourceDistillationMessages,
  distillSources,
} from "../src/modules/sources/distillation.service.js";
import * as candidatesUtil from "../src/modules/distillation/distillation-candidates.js";
import * as promptsUtil from "../src/modules/distillation/distillation-prompts.js";
import * as runtime from "../src/modules/distillation/distillation-runtime.service.js";
import * as embedding from "../src/modules/embedding/embedding.service.js";
import * as knowledgeRepo from "../src/modules/knowledge/knowledge.repository.js";
import * as repository from "../src/modules/sources/distillation.repository.js";
import * as knowledgeDedup from "../src/lib/knowledge-dedup.js";

vi.mock("../src/modules/sources/distillation.repository.js");
vi.mock("../src/modules/distillation/distillation-candidate.repository.js", () => ({
  attachDistillationCandidateRun: vi.fn().mockResolvedValue(undefined),
  claimDistillationCandidateForEvaluation: vi.fn((id: string) => Promise.resolve({ id })),
  listPromotionReadyDistillationCandidates: vi.fn().mockResolvedValue([]),
  distillationCandidateRowToCandidate: vi.fn((row: any) => ({
    type: row.type,
    title: row.title,
    body: row.body,
    confidence: row.confidence ?? 65,
    importance: row.importance ?? 55,
  })),
  listUnevaluatedDistillationCandidates: vi.fn().mockResolvedValue([]),
  markDistillationCandidateEvaluating: vi.fn().mockResolvedValue(undefined),
  updateDistillationCandidateEvaluation: vi.fn().mockResolvedValue(undefined),
  upsertExtractedDistillationCandidates: vi.fn((params: any) =>
    Promise.resolve(
      params.candidates.map((candidate: any, index: number) => ({
        id: `candidate-${index}`,
        sourceKind: params.source.sourceKind,
        sourceFragmentId: params.source.sourceFragmentId ?? null,
        vibeMemoryId: params.source.vibeMemoryId ?? null,
        candidateIndex: index,
        ...candidate,
      })),
    ),
  ),
}));
vi.mock("../src/modules/knowledge/knowledge.repository.js");
vi.mock("../src/modules/distillation/distillation-candidates.js");
vi.mock("../src/modules/distillation/distillation-prompts.js");
vi.mock("../src/modules/distillation/distillation-runtime.service.js");
vi.mock("../src/modules/embedding/embedding.service.js");
vi.mock("../src/lib/knowledge-dedup.js");
vi.mock("../src/modules/distillation/distillation-job.service.js", () => ({
  beginDistillationJob: vi.fn().mockResolvedValue({ id: "job-1" }),
  checkDistillationCircuitBreaker: vi.fn().mockResolvedValue({ allowed: true }),
  pauseJobForCircuitBreaker: vi.fn().mockResolvedValue(undefined),
  shouldPauseDistillationPromotion: vi.fn().mockResolvedValue({
    paused: false,
    draftCount: 0,
    threshold: 50,
  }),
}));
vi.mock("../src/modules/distillation/distillation-job.repository.js", () => ({
  finishDistillationJob: vi.fn().mockResolvedValue(undefined),
  updateDistillationJobPhase: vi.fn().mockResolvedValue(undefined),
}));

const originalSourceDistillationConfig = {
  batchSize: groupedConfig.sourceDistillation.batchSize,
  promptVersion: groupedConfig.sourceDistillation.promptVersion,
  maxInputChars: groupedConfig.sourceDistillation.maxInputChars,
  maxOutputTokens: groupedConfig.sourceDistillation.maxOutputTokens,
};
const originalLocalLlmModel = groupedConfig.localLlm.model;

function searchToolEvent() {
  return {
    callId: "search-1",
    name: "search_web",
    ok: true,
    content: "Search evidence",
  };
}

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
    sourceMetadata: { repoPath: "/test/repo", repoKey: "/test/repo" },
  };

  beforeEach(() => {
    vi.clearAllMocks();

    groupedConfig.sourceDistillation.batchSize = 5;
    groupedConfig.sourceDistillation.promptVersion = "v1";
    groupedConfig.sourceDistillation.maxInputChars = 1000;
    groupedConfig.sourceDistillation.maxOutputTokens = 500;
    groupedConfig.localLlm.model = "test-model";

    vi.mocked(repository.listSourceFragmentsForDistillation).mockResolvedValue([
      mockFragment as unknown as never,
    ]);
    vi.mocked(promptsUtil.buildDistillationSystemPrompt).mockReturnValue("system prompt");
    vi.mocked(candidatesUtil.parseDistillationCandidateList).mockReturnValue([]);
    vi.mocked(candidatesUtil.parseDistillationCandidateListWithMetadata).mockReturnValue({
      candidates: [],
      jsonRepaired: false,
      parseStrategies: [],
    });
    vi.mocked(candidatesUtil.validateDistillationCandidates).mockReturnValue({
      accepted: [],
      rejectedLowQuality: [],
      rejectedInvalidEvidence: [],
    });
    vi.mocked(runtime.distillationToolEventsFromError).mockReturnValue([]);
    vi.mocked(knowledgeDedup.checkKnowledgeDuplicate).mockResolvedValue({ isDuplicate: false });
  });

  afterAll(() => {
    groupedConfig.sourceDistillation.batchSize = originalSourceDistillationConfig.batchSize;
    groupedConfig.sourceDistillation.promptVersion = originalSourceDistillationConfig.promptVersion;
    groupedConfig.sourceDistillation.maxInputChars = originalSourceDistillationConfig.maxInputChars;
    groupedConfig.sourceDistillation.maxOutputTokens =
      originalSourceDistillationConfig.maxOutputTokens;
    groupedConfig.localLlm.model = originalLocalLlmModel;
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
      vi.mocked(runtime.runDistillationCompletion).mockResolvedValue(mockCompletion);

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
        sourceRefs: ["ref1"],
      };
      const mockCompletion = {
        content: '{"candidates":[...]}',
        toolEvents: [searchToolEvent()],
        messages: [],
      };

      vi.mocked(runtime.runDistillationCompletion).mockResolvedValue(mockCompletion);
      vi.mocked(candidatesUtil.parseDistillationCandidateList).mockReturnValue([mockCandidate]);
      vi.mocked(candidatesUtil.parseDistillationCandidateListWithMetadata).mockReturnValue({
        candidates: [mockCandidate],
        jsonRepaired: false,
        parseStrategies: [],
      });
      vi.mocked(candidatesUtil.validateDistillationCandidates).mockReturnValue({
        accepted: [mockCandidate],
        rejectedLowQuality: [],
        rejectedInvalidEvidence: [],
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
      vi.mocked(runtime.runDistillationCompletion).mockRejectedValue(new Error("LLM failure"));
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

    test("does not require extra repair call for non-JSON output", async () => {
      const mockCompletion = {
        content: "TYPE: rule\nTITLE: non-json\nBODY: still parseable",
        toolEvents: [],
        messages: [],
      };
      const mockModelClient = vi.fn().mockResolvedValue(mockCompletion);

      await distillSources({ apply: false, modelClient: mockModelClient });

      expect(mockModelClient).toHaveBeenCalledTimes(1);
    });
  });
});
