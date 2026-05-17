import { describe, expect, test } from "vitest";
import {
  classifyFailedDistillationOutcome,
  classifySkippedDistillationOutcome,
  classifySuccessfulDistillationOutcome,
} from "../src/modules/distillation/distillation-outcomes.js";

describe("distillation outcome classification", () => {
  test("classifies skipped runs without extracted candidates as no_candidate", () => {
    expect(
      classifySkippedDistillationOutcome({
        extractionCandidateCount: 0,
        verificationCandidateCount: 0,
        rejectedLowQualityCount: 0,
        rejectedInvalidEvidenceCount: 0,
        failedCandidateCount: 0,
      }),
    ).toEqual({
      outcomeKind: "no_candidate",
      legacyReason: "no_rule_or_procedure_candidates",
    });
  });

  test("distinguishes verification returning no candidates from extraction no-candidate", () => {
    expect(
      classifySkippedDistillationOutcome({
        extractionCandidateCount: 2,
        verificationCandidateCount: 0,
        rejectedLowQualityCount: 0,
        rejectedInvalidEvidenceCount: 0,
        failedCandidateCount: 0,
      }).outcomeKind,
    ).toBe("verification_no_candidate");
  });

  test("classifies tool-evidence failures separately from evidence quality failures", () => {
    expect(
      classifySkippedDistillationOutcome({
        extractionCandidateCount: 1,
        verificationCandidateCount: 1,
        rejectedLowQualityCount: 0,
        rejectedInvalidEvidenceCount: 1,
        failedCandidateCount: 1,
      }).outcomeKind,
    ).toBe("missing_verification_tool_evidence");

    expect(
      classifySkippedDistillationOutcome({
        extractionCandidateCount: 1,
        verificationCandidateCount: 1,
        rejectedLowQualityCount: 0,
        rejectedInvalidEvidenceCount: 1,
        failedCandidateCount: 0,
      }).outcomeKind,
    ).toBe("missing_external_evidence");
  });

  test("classifies invalid candidates", () => {
    expect(
      classifySkippedDistillationOutcome({
        extractionCandidateCount: 1,
        verificationCandidateCount: 1,
        rejectedLowQualityCount: 1,
        rejectedInvalidEvidenceCount: 0,
        failedCandidateCount: 0,
      }).outcomeKind,
    ).toBe("invalid_candidate");
  });

  test("classifies successful and failed runs", () => {
    expect(
      classifySuccessfulDistillationOutcome({
        apply: true,
        acceptedCandidateCount: 2,
        dedupSkippedCount: 0,
      }),
    ).toBe("knowledge_created");
    expect(
      classifySuccessfulDistillationOutcome({
        apply: true,
        acceptedCandidateCount: 2,
        dedupSkippedCount: 2,
      }),
    ).toBe("knowledge_deduped");
    expect(
      classifyFailedDistillationOutcome({
        message: "distillation LLM request timed out after 120000ms",
        failureKind: "llm_call",
      }),
    ).toBe("llm_timeout");
  });
});
