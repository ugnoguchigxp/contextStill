import { db } from "../../db/index.js";
import { distillationReadEvents } from "../../db/schema.js";
import type { DistillationCandidateSourceRef } from "./distillation-candidate.repository.js";

function sourceValues(source: DistillationCandidateSourceRef) {
  return source.sourceKind === "vibe_memory"
    ? {
        sourceKind: source.sourceKind,
        vibeMemoryId: source.vibeMemoryId,
        sourceFragmentId: null,
      }
    : {
        sourceKind: source.sourceKind,
        vibeMemoryId: null,
        sourceFragmentId: source.sourceFragmentId,
      };
}

export async function recordDistillationReadEvent(params: {
  jobId?: string;
  candidateId?: string;
  source: DistillationCandidateSourceRef;
  locator: string;
  purpose?: string;
  contentHash: string;
  charCount: number;
  truncated: boolean;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await db.insert(distillationReadEvents).values({
    jobId: params.jobId,
    candidateId: params.candidateId,
    ...sourceValues(params.source),
    locator: params.locator,
    purpose: params.purpose,
    contentHash: params.contentHash,
    charCount: params.charCount,
    truncated: params.truncated ? 1 : 0,
    metadata: params.metadata ?? {},
  });
}
