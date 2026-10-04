import { resolveWriterEndpoint } from "../../db/sqlite/writer-client.js";
import type { CoverEvidenceRunInput, CoverEvidenceRunResult } from "../coverEvidence/domain.js";
import type { CoverEvidenceResult } from "../coverEvidence/types.js";
import type { FindCandidateInput, FindCandidateResult } from "../findCandidate/domain.js";
import type { CandidateRecord } from "../findCandidate/repository.js";

type Receipt = {
  ok: boolean;
  error?: string;
  queue: "findingCandidate" | "coveringEvidence";
  jobId: string;
  target?: { targetKind: FindCandidateResult["targetKind"]; targetKey: string };
};
type Status = {
  ok: boolean;
  status: string;
  error?: string;
  reason?: string;
  candidates?: Array<{ candidate: CandidateRecord }>;
  assessment?: { result: CoverEvidenceResult };
  result?: CoverEvidenceResult;
  candidateIds: string[];
  readRanges?: Array<[string, number, number]>;
};

/** The resident owns routing, budgets, inference and projections. Cancellation of
 * this wait leaves the durable job available to the resident; it never resubmits. */
export async function nativeAgentRequest<T>(body: unknown, signal?: AbortSignal): Promise<T> {
  const endpoint = resolveWriterEndpoint();
  const url = new URL(endpoint.url);
  url.pathname = "/internal/agent-runtime";
  url.search = "";
  const response = await fetch(url, {
    method: "POST",
    redirect: "error",
    signal,
    headers: { authorization: `Bearer ${endpoint.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = (await response.json()) as T & { ok?: boolean; error?: string };
  if (!response.ok || result.ok !== true)
    throw new Error(result.error ?? "native agent request failed");
  return result;
}
async function wait(receipt: Receipt, signal?: AbortSignal): Promise<Status> {
  const deadline = Date.now() + 660_000;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const status = await nativeAgentRequest<Status>(
      { operation: "status", queue: receipt.queue, jobId: receipt.jobId },
      signal,
    );
    if (status.status === "completed" || status.status === "skipped") return status;
    if (status.status === "paused" || status.status === "failed") {
      throw new Error(`native ${receipt.queue}: ${status.error ?? status.reason ?? status.status}`);
    }
    await Bun.sleep(500);
  }
  throw new Error(`native agent wait timed out; durable job ${receipt.jobId} remains queued`);
}
export async function runNativeFinding(input: FindCandidateInput): Promise<FindCandidateResult> {
  if (input.provider || (input.fromToken ?? 0) !== 0 || input.memoryReaderMode === "original") {
    throw new Error(
      "native Finding owns Provider routing and filtered byte windows; provider, fromToken and original-memory overrides are unsupported",
    );
  }
  const callerMode = input.callerMode ?? "cli_text";
  const receipt = await nativeAgentRequest<Receipt>(
    {
      operation: "finding",
      targetStateId: input.targetStateId,
      sourceInput: input.sourceInput,
      preview: callerMode === "cli_text",
    },
    input.signal,
  );
  if (!receipt.target) throw new Error("native Finding target receipt missing");
  const status = await wait(receipt, input.signal);
  return {
    targetStateId: input.targetStateId ?? null,
    targetKind: receipt.target.targetKind,
    targetKey: receipt.target.targetKey,
    callerMode,
    candidates: (status.candidates ?? []).map((draft) => draft.candidate),
    ...(callerMode === "storage" ? { insertedIds: status.candidateIds } : {}),
    readRanges: (status.readRanges ?? []).map((r) => ({ from: r[1], toExclusive: r[2] })),
    readRangeUnit: "utf8_bytes",
  };
}
export async function runNativeCovering(
  input: CoverEvidenceRunInput,
): Promise<CoverEvidenceRunResult> {
  if (
    input.provider ||
    input.providerPolicy === "cloud_api" ||
    input.chatClient ||
    input.toolExecutor
  ) {
    throw new Error(
      "native Covering owns Provider routing and acquisition; direct runtime overrides are unsupported",
    );
  }
  const receipt = await nativeAgentRequest<Receipt>(
    {
      operation: "covering",
      candidateId: input.id,
      preview: !input.write,
      reprocess: Boolean(input.forceRefreshEvidence),
    },
    input.signal,
  );
  const status = await wait(receipt, input.signal);
  if (!status.result) throw new Error("native Covering projection receipt missing");
  const result = status.result;
  const raw = result.candidate as
    | (NonNullable<CoverEvidenceResult["candidate"]> & {
        appliesTo?: {
          general?: boolean;
          technologies?: string[];
          changeTypes?: string[];
          domains?: string[];
          repoKey?: string;
          repoPath?: string;
        };
      })
    | null;
  if (raw?.appliesTo) {
    const { appliesTo, ...candidate } = raw;
    result.candidate = { ...candidate, ...appliesTo, applicabilityGeneral: appliesTo.general };
  }
  return { id: input.id, result };
}
