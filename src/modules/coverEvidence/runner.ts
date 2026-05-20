import type { DistillationProviderSetting } from "../distillation/distillation-runtime.service.js";
import { runCoverEvidence } from "./domain.js";
import type { CoverEvidenceStage, CoverEvidenceStatus } from "./types.js";

export type CoverEvidenceRunnerInput = {
  targetStateId: string;
  findCandidateId: string;
  provider?: DistillationProviderSetting;
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
  "tool_failed",
  "provider_failed",
  "parse_failed",
]);

export async function runCoverEvidenceForCandidate(
  input: CoverEvidenceRunnerInput,
): Promise<CoverEvidenceRunnerResult> {
  const result = await runCoverEvidence({
    id: input.findCandidateId,
    provider: input.provider,
    write: true,
    forceRefreshEvidence: input.forceRefreshEvidence,
    signal: input.signal,
  });

  return {
    coverEvidenceResultId: result.id,
    findCandidateId: input.findCandidateId,
    status: result.result.status,
    stage: result.result.stage,
    retryable: retryableStatuses.has(result.result.status),
    reason: result.result.reason,
  };
}
