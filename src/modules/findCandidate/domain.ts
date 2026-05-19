import type { DistillationDomainSmokeResult } from "../distillation-domain.types.js";

export async function runFindCandidateSmoke(
  input: Record<string, unknown>,
): Promise<DistillationDomainSmokeResult> {
  return {
    domain: "findCandidate",
    implemented: false,
    status: "prepared",
    checkedAt: new Date().toISOString(),
    message: "findCandidate domain is scaffolded. Implementation is intentionally pending.",
    receivedInput: input,
    nextContracts: [
      "Input contract for source units (fragment/memory/diff boundary)",
      "Candidate shape contract (type/title/body/confidence/importance/sourceRefs)",
      "Deterministic no-candidate signaling contract",
    ],
  };
}
