import type { DistillationProviderSetting } from "../distillation/distillation-runtime.service.js";
import type { CoverEvidenceProviderPolicy } from "./provider-policy.js";
import { runCoverEvidence } from "./domain.js";
import type {
  CoverEvidenceCandidateInput,
  CoverEvidenceStage,
  CoverEvidenceStatus,
} from "./types.js";

export type CoverEvidenceRunnerInput =
  | {
      targetStateId: string;
      findCandidateId: string;
      provider?: DistillationProviderSetting;
      providerPolicy?: CoverEvidenceProviderPolicy;
      providerFallbackMode?: "fallback" | "single";
      forceRefreshEvidence?: boolean;
      signal?: AbortSignal;
    }
  | {
      candidate: CoverEvidenceCandidateInput;
      provider?: DistillationProviderSetting;
      providerPolicy?: CoverEvidenceProviderPolicy;
      providerFallbackMode?: "fallback" | "single";
      forceRefreshEvidence?: boolean;
      signal?: AbortSignal;
    };

export type CoverEvidenceRunnerResult = {
  coverEvidenceResultId: string;
  findCandidateId: string;
  status: CoverEvidenceStatus;
  stage: CoverEvidenceStage;
  retryable: boolean;
  reason: string | null;
};

const retryableStatuses = new Set<CoverEvidenceStatus>([
  "reprocess_requested",
  "tool_failed",
  "provider_failed",
  "parse_failed",
]);

export async function runCoverEvidenceForCandidate(
  input: CoverEvidenceRunnerInput,
): Promise<CoverEvidenceRunnerResult> {
  const id = "findCandidateId" in input ? input.findCandidateId : input.candidate.id;
  const result = await runCoverEvidence({
    id,
    candidate: "candidate" in input ? input.candidate : undefined,
    provider: input.provider,
    providerPolicy: input.providerPolicy,
    providerFallbackMode: input.providerFallbackMode,
    write: !("candidate" in input),
    forceRefreshEvidence: input.forceRefreshEvidence,
    signal: input.signal,
  });

  return {
    coverEvidenceResultId: result.id,
    findCandidateId: id,
    status: result.result.status,
    stage: result.result.stage,
    retryable: retryableStatuses.has(result.result.status),
    reason: result.result.reason,
  };
}
