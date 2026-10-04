import { z } from "zod";
import { canonicalJsonSha256 } from "../../shared/utils/canonical-json.js";
import {
  registerCandidate,
  type RegisterCandidateInput,
  type RegisterCandidateResult,
} from "../registerCandidate/register-candidate.service.js";
import { resolveProjectScopedWriteIdentity } from "../context-compiler/project-scoped-write.js";
import {
  getManualResearch,
  manualResearchDatabase,
  ManualResearchConflict,
  type ManualResearchRun,
} from "./manual-research.service.js";

export const researchImportSchema = z.object({
  claimIds: z
    .array(z.string().min(1).max(100))
    .min(1)
    .max(10)
    .refine((ids) => new Set(ids).size === ids.length),
  scope: z.enum(["global", "repo"]),
  repoPath: z.string().trim().min(1).max(2048).optional(),
  projectRef: z.string().trim().min(1).max(256).optional(),
});
type ResearchImport = z.infer<typeof researchImportSchema>;

export function researchRegistration(
  run: ManualResearchRun,
  claimId: string,
  scope: Omit<ResearchImport, "claimIds">,
): RegisterCandidateInput {
  const result = run.result;
  const claim = result?.claims.find((candidate) => candidate.id === claimId);
  if (!claim || !result || !run.resultHash) throw new Error("RESEARCH_CANDIDATE_UNAVAILABLE");
  const candidateIndex = result.claims.indexOf(claim);
  const candidate = result.exploration?.candidates[candidateIndex];
  const sources = claim.evidenceIds
    .map((id) => result.evidence.find((source) => source.id === id))
    .filter((source) => source !== undefined);
  if (!sources.length) throw new Error("RESEARCH_CANDIDATE_WITHOUT_SOURCE");
  const body = candidate
    ? [
        candidate.knowledge,
        `関連性: ${candidate.relevance}`,
        ...candidate.sources.map(
          (source) =>
            `出典: ${source.title}\n${source.url}\n確認: ${source.verification}（Codex申告）\n抜粋: ${source.excerpt}\n箇所: ${source.location}\n情報時点: ${source.informationDate ?? "不明"}`,
        ),
        `不確実性: ${candidate.uncertainties.join(" / ") || "記載なし"}`,
        `反証・食い違い: ${candidate.contradictions.join(" / ") || "記載なし"}`,
      ].join("\n\n")
    : [
        claim.text,
        ...sources.map(
          (source) => `出典: ${source.sourceTitle}\n${source.sourceUrl}\n引用: ${source.quote}`,
        ),
      ].join("\n\n");
  return {
    ...scope,
    title: candidate?.title ?? claim.text.slice(0, 96),
    body,
    type: "rule",
    metadata: {
      manualResearchImportKey: `${run.id}/${claimId}`,
      research: {
        engine: run.engine,
        runId: run.id,
        resultHash: run.resultHash,
        claimId,
        topic: run.topic,
        candidate: candidate ?? null,
        evidence: sources,
        termination: result.reason,
      },
    },
  };
}

export async function importResearchCandidates(id: string, input: ResearchImport) {
  const parsed = researchImportSchema.parse(input);
  const run = await getManualResearch(id);
  if (!run) throw new Error("RESEARCH_RUN_NOT_FOUND");
  // Validation happens before reserving a receipt or creating any queue rows.
  resolveProjectScopedWriteIdentity(parsed);
  const scope = {
    scope: parsed.scope,
    ...(parsed.repoPath ? { repoPath: parsed.repoPath } : {}),
    ...(parsed.projectRef ? { projectRef: parsed.projectRef } : {}),
  };
  const registrations = parsed.claimIds.map((claim) => researchRegistration(run, claim, scope));
  const db = await manualResearchDatabase();
  const receipts: RegisterCandidateResult[] = [];
  for (const [index, claimId] of parsed.claimIds.entries()) {
    const registration = registrations[index];
    const requestHash = canonicalJsonSha256(registration);
    const reservation = db
      .query(
        "INSERT OR IGNORE INTO manual_research_candidate_imports(run_id,claim_id,request_hash) VALUES(?,?,?)",
      )
      .run(id, claimId, requestHash);
    const stored = db
      .query<{ request_hash: string; receipt_json: string | null }, [string, string]>(
        "SELECT request_hash,receipt_json FROM manual_research_candidate_imports WHERE run_id=? AND claim_id=?",
      )
      .get(id, claimId);
    if (!stored || stored.request_hash !== requestHash)
      throw new ManualResearchConflict("RESEARCH_IMPORT_SCOPE_CONFLICT");
    if (stored.receipt_json) {
      receipts.push(JSON.parse(stored.receipt_json) as RegisterCandidateResult);
      continue;
    }
    if (reservation.changes !== 1)
      throw new ManualResearchConflict("RESEARCH_IMPORT_UNCONFIRMED_CHECK_QUEUE");
    // A reserved receipt prevents duplicate registration after process loss or an
    // uncertain acknowledgement. Never automatically repeat a queue mutation.
    const receipt = await registerCandidate(registration);
    const saved = db
      .query(
        "UPDATE manual_research_candidate_imports SET receipt_json=? WHERE run_id=? AND claim_id=? AND receipt_json IS NULL",
      )
      .run(JSON.stringify(receipt), id, claimId);
    if (saved.changes !== 1) throw new Error("RESEARCH_IMPORT_NOT_CONFIRMED");
    receipts.push(receipt);
  }
  return { receipts };
}

export function researchMetrics(run: ManualResearchRun, selectedCount = 0) {
  const outcome = run.result?.exploration;
  const claims = run.result?.claims ?? [];
  const withReadEvidence = claims.filter((claim, index) =>
    outcome
      ? outcome.candidates[index]?.sources.some((source) => source.verification === "source_read")
      : claim.evidenceIds.length > 0,
  ).length;
  return {
    id: run.id,
    engine: run.engine,
    topic: run.topic,
    status: run.status,
    model: outcome?.model ?? null,
    reasoningEffort: outcome?.reasoningEffort ?? null,
    candidateCount: claims.length,
    withReadEvidence,
    selectedCount,
    elapsedMs:
      outcome?.elapsedMs ??
      (run.lastSyncedAt && ["completed", "partial", "failed", "cancelled"].includes(run.status)
        ? Math.max(0, Date.parse(run.lastSyncedAt) - Date.parse(run.createdAt))
        : null),
    tokenUsage: outcome?.tokenUsage ?? {
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      reasoningOutputTokens: null,
    },
    totalTokens: run.result?.usage.tokens ?? null,
    usageComplete: outcome?.usageComplete ?? false,
    termination: run.result?.reason ?? run.syncError,
    codexOptions: run.codex,
  };
}

export async function compareResearch(topic: string) {
  const { listManualResearch } = await import("./manual-research.service.js");
  const runs = (await listManualResearch()).filter((run) => run.topic === topic);
  const db = await manualResearchDatabase();
  return runs.map((run) =>
    researchMetrics(
      run,
      db
        .query<{ count: number }, [string]>(
          "SELECT count(*) AS count FROM manual_research_candidate_imports WHERE run_id=? AND receipt_json IS NOT NULL",
        )
        .get(run.id)?.count ?? 0,
    ),
  );
}
