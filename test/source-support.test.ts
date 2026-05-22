import { describe, expect, test } from "vitest";
import { readSourceEvidenceForCandidate } from "../src/modules/coverEvidence/source-support.service.js";
import type { FindCandidateResultRow } from "../src/modules/findCandidate/repository.js";

describe("readSourceEvidenceForCandidate", () => {
  test("uses registered candidate content as source evidence", async () => {
    const result = await readSourceEvidenceForCandidate({
      id: "find-1",
      targetStateId: "target-1",
      candidateIndex: 0,
      title: "Candidate",
      content: "Use when:\n- A\n\nWorkflow:\n1. B\n2. C",
      origin: {},
      status: "selected",
      createdAt: new Date("2026-05-22T00:00:00.000Z"),
      updatedAt: new Date("2026-05-22T00:00:00.000Z"),
      targetKind: "knowledge_candidate",
      targetKey: "candidate-1",
      sourceUri: "agent://candidate/candidate-1",
    } satisfies FindCandidateResultRow);

    expect(result.content).toContain("Use when:");
    expect(result.references).toEqual([
      expect.objectContaining({
        uri: "agent://candidate/candidate-1",
        locator: "candidate:content",
        evidenceRole: "supports_candidate",
      }),
    ]);
  });
});
