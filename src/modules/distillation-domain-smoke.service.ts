import { runCoverEvidenceSmoke } from "./coverEvidence/domain.js";
import { runFinalizeDistilleSmoke } from "./finalizeDistille/domain.js";
import { runFindCandidateSmoke } from "./findCandidate/domain.js";
import type { DistillationDomainName, DistillationDomainSmokeResult } from "./distillation-domain.types.js";

function normalizeInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  return input as Record<string, unknown>;
}

export async function runDistillationDomainSmoke(params: {
  domain: DistillationDomainName;
  input?: unknown;
}): Promise<DistillationDomainSmokeResult> {
  const input = normalizeInput(params.input);
  if (params.domain === "findCandidate") {
    return runFindCandidateSmoke(input);
  }
  if (params.domain === "coverEvidence") {
    return runCoverEvidenceSmoke(input);
  }
  return runFinalizeDistilleSmoke(input);
}
