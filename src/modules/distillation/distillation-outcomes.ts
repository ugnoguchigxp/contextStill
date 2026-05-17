export type DistillationOutcomeKind =
  | "candidate_ready"
  | "knowledge_created"
  | "knowledge_deduped"
  | "no_candidate"
  | "verification_no_candidate"
  | "missing_verification_tool_evidence"
  | "missing_external_evidence"
  | "invalid_candidate"
  | "mixed_candidate_rejections"
  | "candidate_rejected"
  | "llm_timeout"
  | "llm_empty_response"
  | "llm_unparseable"
  | "llm_provider_error"
  | "concurrent_claim_conflict"
  | "processing_error";

export type SkippedDistillationOutcome = {
  outcomeKind: DistillationOutcomeKind;
  legacyReason: string;
};

export function classifySkippedDistillationOutcome(params: {
  extractionCandidateCount: number;
  verificationCandidateCount: number;
  rejectedLowQualityCount: number;
  rejectedInvalidEvidenceCount: number;
  failedCandidateCount: number;
}): SkippedDistillationOutcome {
  if (params.extractionCandidateCount === 0) {
    return {
      outcomeKind: "no_candidate",
      legacyReason: "no_rule_or_procedure_candidates",
    };
  }

  if (params.verificationCandidateCount === 0) {
    return {
      outcomeKind: "verification_no_candidate",
      legacyReason: "all_candidates_rejected",
    };
  }

  if (
    params.failedCandidateCount > 0 &&
    params.rejectedInvalidEvidenceCount > 0 &&
    params.rejectedLowQualityCount === 0
  ) {
    return {
      outcomeKind: "missing_verification_tool_evidence",
      legacyReason: "all_candidates_missing_external_evidence",
    };
  }

  if (params.rejectedInvalidEvidenceCount > 0 && params.rejectedLowQualityCount === 0) {
    return {
      outcomeKind: "missing_external_evidence",
      legacyReason: "all_candidates_missing_external_evidence",
    };
  }

  if (params.rejectedLowQualityCount > 0 && params.rejectedInvalidEvidenceCount === 0) {
    return {
      outcomeKind: "invalid_candidate",
      legacyReason: "all_candidates_invalid",
    };
  }

  if (
    params.rejectedLowQualityCount > 0 ||
    params.rejectedInvalidEvidenceCount > 0 ||
    params.failedCandidateCount > 0
  ) {
    return {
      outcomeKind: "mixed_candidate_rejections",
      legacyReason: "all_candidates_rejected",
    };
  }

  return {
    outcomeKind: "candidate_rejected",
    legacyReason: "all_candidates_rejected",
  };
}

export function classifySuccessfulDistillationOutcome(params: {
  apply: boolean;
  acceptedCandidateCount: number;
  dedupSkippedCount: number;
}): DistillationOutcomeKind {
  if (!params.apply) return "candidate_ready";
  if (
    params.acceptedCandidateCount > 0 &&
    params.dedupSkippedCount >= params.acceptedCandidateCount
  ) {
    return "knowledge_deduped";
  }
  return "knowledge_created";
}

export function classifyFailedDistillationOutcome(params: {
  message: string;
  failureKind: "llm_call" | "parse_or_repair" | "processing";
}): DistillationOutcomeKind {
  const message = params.message.toLowerCase();
  if (message.includes("timed out") || message.includes("timeout")) return "llm_timeout";
  if (message.includes("already claimed")) return "concurrent_claim_conflict";
  if (message.includes("did not include assistant content")) return "llm_empty_response";
  if (
    params.failureKind === "parse_or_repair" ||
    message.includes("invalid after json repair") ||
    message.includes("did not contain valid json")
  ) {
    return "llm_unparseable";
  }
  if (params.failureKind === "llm_call") return "llm_provider_error";
  return "processing_error";
}
