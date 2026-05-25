import { describe, expect, test, vi, beforeEach } from "vitest";
import { runCoverEvidenceForCandidate } from "../src/modules/coverEvidence/runner.js";
import { runCoverEvidence } from "../src/modules/coverEvidence/domain.js";

vi.mock("../src/modules/coverEvidence/domain.js", () => {
  return {
    runCoverEvidence: vi.fn(),
  };
});

describe("Cover Evidence Runner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("runs cover evidence successfully and maps to runner result", async () => {
    vi.mocked(runCoverEvidence).mockResolvedValue({
      id: "result-1",
      result: {
        schemaVersion: 1,
        status: "knowledge_ready",
        stage: "final",
        candidate: null,
        references: [],
        duplicateRefs: [],
        toolEvents: [],
        reason: "Success",
      },
    });

    const res = await runCoverEvidenceForCandidate({
      targetStateId: "target-1",
      findCandidateId: "candidate-1",
      forceRefreshEvidence: false,
    });

    expect(res).toEqual({
      coverEvidenceResultId: "result-1",
      findCandidateId: "candidate-1",
      status: "knowledge_ready",
      stage: "final",
      retryable: false,
      reason: "Success",
    });
    expect(runCoverEvidence).toHaveBeenCalledWith({
      id: "candidate-1",
      provider: undefined,
      providerPolicy: undefined,
      providerFallbackMode: undefined,
      write: true,
      forceRefreshEvidence: false,
      signal: undefined,
    });
  });

  test("identifies retryable statuses", async () => {
    vi.mocked(runCoverEvidence).mockResolvedValue({
      id: "result-2",
      result: {
        schemaVersion: 1,
        status: "tool_failed",
        stage: "evidence_need",
        candidate: null,
        references: [],
        duplicateRefs: [],
        toolEvents: [],
        reason: "Failed due to tool error",
      },
    });

    const res = await runCoverEvidenceForCandidate({
      targetStateId: "target-2",
      findCandidateId: "candidate-2",
      forceRefreshEvidence: true,
    });

    expect(res.retryable).toBe(true);
    expect(res.status).toBe("tool_failed");
  });
});
