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
    expect(result.primaryContent).toContain("Use when:");
    expect(result.assessmentContent).toContain("Use when:");
    expect(result.assessmentSource).toBe("primary");
    expect(result.references).toEqual([
      expect.objectContaining({
        uri: "agent://candidate/candidate-1",
        locator: "candidate:content",
        evidenceRole: "supports_candidate",
      }),
    ]);
  });

  test("does not use candidate content when a vibe memory source is unavailable", async () => {
    mocks.readVibeMemoryByTokenWindow.mockRejectedValue(new Error("vibe memory not found"));

    await expect(
      readSourceEvidenceForCandidate({
        id: "find-1",
        targetStateId: "target-1",
        title: "Candidate",
        content: "Use web evidence to validate this candidate when the source memory is gone.",
        origin: { readRanges: [{ from: 0, toExclusive: 80 }] },
        status: "selected",
        targetKind: "vibe_memory",
        targetKey: "missing-memory",
        sourceUri: "vibe_memory:missing-memory",
      } satisfies CoverEvidenceCandidateInput),
    ).rejects.toThrow("vibe memory not found");
  });

  test("uses source summary fallback as non-primary evidence when original source is unavailable", async () => {
    mocks.readVibeMemoryByTokenWindow.mockRejectedValue(new Error("vibe memory not found"));

    const result = await readSourceEvidenceForCandidate({
      id: "find-1",
      targetStateId: "target-1",
      title: "Candidate",
      content: "Run focused tests before finalize when source references need checking.",
      origin: {
        sourceSummary:
          "The source says focused tests should run before finalize and source references should be checked.",
        readRanges: [{ from: 0, toExclusive: 80 }],
      },
      status: "selected",
      targetKind: "vibe_memory",
      targetKey: "missing-memory",
      sourceUri: "vibe_memory:missing-memory",
    } satisfies CoverEvidenceCandidateInput);

    expect(result.primaryContent).toBeNull();
    expect(result.content).toBe("");
    expect(result.assessmentContent).toContain("focused tests");
    expect(result.valueAssessmentContent).toBe(result.assessmentContent);
    expect(result.assessmentSource).toBe("source_summary");
    expect(result.references).toEqual([
      expect.objectContaining({
        uri: "vibe_memory:missing-memory",
        locator: "sourceSummary",
        evidenceRole: "source_summary",
      }),
    ]);
  });
});
