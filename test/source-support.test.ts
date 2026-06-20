import { beforeEach, describe, expect, test, vi } from "vitest";
import { readSourceEvidenceForCandidate } from "../src/modules/coverEvidence/source-support.service.js";
import type { CoverEvidenceCandidateInput } from "../src/modules/coverEvidence/types.js";

const mocks = vi.hoisted(() => ({
  readVibeMemoryByTokenWindow: vi.fn(),
}));

vi.mock("../src/modules/memoryReader/reader.service.js", () => ({
  readVibeMemoryByTokenWindow: mocks.readVibeMemoryByTokenWindow,
}));

describe("readSourceEvidenceForCandidate", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  test("uses registered candidate content as source evidence", async () => {
    const result = await readSourceEvidenceForCandidate({
      id: "find-1",
      targetStateId: "target-1",
      title: "Candidate",
      content: "Use when:\n- A\n\nWorkflow:\n1. B\n2. C",
      origin: {},
      status: "selected",
      targetKind: "knowledge_candidate",
      targetKey: "candidate-1",
      sourceUri: "agent://candidate/candidate-1",
    } satisfies CoverEvidenceCandidateInput);

    expect(result.content).toContain("Use when:");
    expect(result.references).toEqual([
      expect.objectContaining({
        uri: "agent://candidate/candidate-1",
        locator: "candidate:content",
        evidenceRole: "supports_candidate",
      }),
    ]);
  });

  test("uses candidate content when a vibe memory source is unavailable", async () => {
    mocks.readVibeMemoryByTokenWindow.mockRejectedValue(new Error("vibe memory not found"));

    const result = await readSourceEvidenceForCandidate({
      id: "find-1",
      targetStateId: "target-1",
      title: "Candidate",
      content: "Use web evidence to validate this candidate when the source memory is gone.",
      origin: { readRanges: [{ from: 0, toExclusive: 80 }] },
      status: "selected",
      targetKind: "vibe_memory",
      targetKey: "missing-memory",
      sourceUri: "vibe_memory:missing-memory",
    } satisfies CoverEvidenceCandidateInput);

    expect(result.content).toBe(
      "Use web evidence to validate this candidate when the source memory is gone.",
    );
    expect(result.valueAssessmentContent).toBe(result.content);
    expect(result.references).toEqual([
      expect.objectContaining({
        uri: "vibe_memory:missing-memory",
        locator: "candidate:content",
        note: "candidate content fallback because source memory is unavailable",
        evidenceRole: "supports_candidate",
      }),
    ]);
  });
});
