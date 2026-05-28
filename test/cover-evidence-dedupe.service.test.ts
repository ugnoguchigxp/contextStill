import { beforeEach, describe, expect, test, vi } from "vitest";
import { dedupeCoverEvidenceCandidate } from "../src/modules/coverEvidence/dedupe.service.js";

const mocks = vi.hoisted(() => ({
  searchKnowledge: vi.fn(),
  findSimilarKnowledge: vi.fn(),
  calculateBigramSimilarity: vi.fn(),
}));

vi.mock("../src/modules/knowledge/knowledge.repository.js", () => ({
  searchKnowledge: mocks.searchKnowledge,
}));

vi.mock("../src/lib/knowledge-dedup.js", () => ({
  findSimilarKnowledge: mocks.findSimilarKnowledge,
  calculateBigramSimilarity: mocks.calculateBigramSimilarity,
}));

function candidate() {
  return {
    type: "rule" as const,
    title: "candidate title",
    body: "candidate body",
    importance: 80,
    confidence: 80,
  };
}

describe("dedupeCoverEvidenceCandidate", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.searchKnowledge.mockResolvedValue([]);
    mocks.findSimilarKnowledge.mockResolvedValue([]);
    mocks.calculateBigramSimilarity.mockReturnValue(0);
  });

  test("treats score 0.93 as duplicate", async () => {
    mocks.searchKnowledge.mockResolvedValue([
      {
        id: "k-1",
        title: "existing title",
        body: "existing body",
        score: 0.9,
      },
    ]);
    mocks.calculateBigramSimilarity.mockImplementation((left: string, right: string) => {
      if (right === "existing body") return 0.93;
      if (right === "existing title") return 0.8;
      return 0;
    });

    const result = await dedupeCoverEvidenceCandidate(candidate());

    expect(result.status).toBe("duplicate");
    expect(result.duplicateRefs[0]).toMatchObject({
      knowledgeId: "k-1",
      score: 0.93,
    });
  });

  test("treats score below 0.93 as near_duplicate", async () => {
    mocks.searchKnowledge.mockResolvedValue([
      {
        id: "k-1",
        title: "existing title",
        body: "existing body",
        score: 0.9,
      },
    ]);
    mocks.calculateBigramSimilarity.mockImplementation((left: string, right: string) => {
      if (right === "existing body") return 0.929;
      if (right === "existing title") return 0.8;
      return 0;
    });

    const result = await dedupeCoverEvidenceCandidate(candidate());

    expect(result.status).toBe("near_duplicate");
    expect(result.duplicateRefs[0]).toMatchObject({
      knowledgeId: "k-1",
      score: 0.929,
    });
  });
});
