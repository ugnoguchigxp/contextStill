import { createHash } from "node:crypto";
import { groupedConfig } from "../../config.js";
import type { CompileRunSource } from "../../shared/schemas/compile-run.schema.js";
import {
  type CompileInput,
  type RetrievalMode,
  compileInputSchema,
  deriveRetrievalModeFromChangeTypes,
} from "../../shared/schemas/compile.schema.js";
import {
  type ContextPack,
  type ContextPackItem,
  contextPackSchema,
} from "../../shared/schemas/context-pack.schema.js";
import type { KnowledgeItem, KnowledgeStatus } from "../../shared/schemas/knowledge.schema.js";
import { auditEventTypes, recordAuditLogSafe } from "../audit/audit-log.service.js";
import { normalizeKnowledgeApplicability } from "../knowledge/applicability.service.js";
import { recordCompileRunKnowledgeUsageSignals } from "../knowledge/knowledge-feedback.service.js";
import { recordKnowledgeCompileSelectionSafe } from "../knowledge/knowledge-value.service.js";
import {
  type KnowledgeCandidateEvidence,
  type KnowledgeRetrievalTraceEntry,
  retrieveKnowledge,
} from "../knowledge/knowledge.service.js";
import {
  applyLandscapeCompileIntervention,
  isLandscapeCompileInterventionEnabled,
} from "../landscape/landscape-compile-intervention.service.js";
import { retrieveSources } from "../sources/source-retrieval.service.js";
import { agenticRefine } from "./agentic-refine.service.js";
import { normalizeRepoKey, normalizeRepoPath } from "./query-context.js";
import {
  insertCompileRun,
  insertContextCompileCandidateTraces,
  insertContextPackItems,
  updateCompileRunSnapshot,
} from "./context-compiler.repository.js";
import { upsertContextCompileTaskTrace } from "./context-compile-task-trace.repository.js";
import { composeContextResponse } from "./context-response-composer.service.js";
import { renderContextPackMarkdown } from "./pack-renderer.js";
import { type Rankable, rankAndDedupe } from "./ranking.service.js";
import { applySectionTokenBudget, estimateTokens } from "./token-budget.js";

const sectionRatios = {
  rules: 0.55,
  procedures: 0.45,
} as const;

const maintenanceReasonSet = new Set([
  "KNOWLEDGE_APPLIES_TO_FALLBACK",
  "KNOWLEDGE_REPO_SCOPE_FALLBACK",
  "SOURCE_REPO_SCOPE_FALLBACK",
  "TOKEN_BUDGET_SECTION_LIMIT_REACHED",
]);
const vectorOnlyScoreFloor = 0.52;
const defaultCandidateTraceLimit = 200;
const designDocumentPathPattern =
  /(?:^|[\s"'`(（])(?:file:\/\/\/[^\s"'`）)]+|(?:\.{1,2}\/)?(?:docs?|design|specs?|requirements?|roadmap|proposal|architecture)\/[^\s"'`）)]+)\.(?:md|mdx)(?=$|[\s"'`）).,])/i;
const designDocumentFileNamePattern =
  /(?:^|[\s"'`(（])(?:design|spec|api-spec|requirements?|roadmap|proposal|architecture(?:-plan)?|plan|設計|仕様|要件)[\w.\-]*(?:\.md|\.mdx)(?=$|[\s"'`）).,])/iu;

type CandidateTraceDraftRow = {
  itemKind: "rule" | "procedure";
  itemId: string;
  textRank: number | null;
  textScore: number | null;
  vectorRank: number | null;
  vectorScore: number | null;
  mergedRank: number | null;
  mergedScore: number | null;
  finalRank: number | null;
  finalScore: number | null;
  selected: boolean;
  suppressed: boolean;
  suppressionReason: string | null;
  agenticDecision: "not_evaluated" | "accepted" | "rejected" | "skipped";
  rankingReason: string | null;
  communityKey: string | null;
  evidence: Record<string, unknown>;
};

function scoreSourceOverlap(text: string, candidateText: string): number {
  const baseTokens = text
    .toLowerCase()
    .split(/[^a-z0-9_\u3040-\u30ff\u4e00-\u9fff\uff61-\uff9f]+/g)
    .filter((token) => token.length >= 3)
    .slice(0, 32);
  if (baseTokens.length === 0) return 0;
  const candidate = candidateText.toLowerCase();
  let overlap = 0;
  for (const token of baseTokens) {
    if (candidate.includes(token)) overlap += 1;
  }
  return overlap;
}

function formatSourceRef(sourceUri: string, locator: string): string {
  return `${sourceUri}#${locator}`;
}

function buildFallbackSourceRef(params: {
  runId: string;
  retrievalMode: RetrievalMode;
  degradedReasons: string[];
}): string {
  const reason =
    params.degradedReasons.find((item) => item.startsWith("NO_")) ??
    params.degradedReasons[0] ??
    "NO_SOURCE_MATCH";
  return `memory-router://packs/run/${params.runId}#${params.retrievalMode}:${reason}`;
}

function selectSourceRefsForKnowledge(
  item: { title: string; content: string },
  sourceItems: Array<{ sourceUri: string; locator: string; content: string; score: number }>,
  knownSourceRefs: string[],
): string[] {
  if (knownSourceRefs.length > 0) {
    return [...new Set(knownSourceRefs)].slice(0, 4);
  }
  if (sourceItems.length === 0) return [];
  const scored = sourceItems
    .map((sourceItem) => {
      const overlap = scoreSourceOverlap(
        `${item.title}\n${item.content}`,
        `${sourceItem.sourceUri}\n${sourceItem.content}`,
      );
      return {
        ref: formatSourceRef(sourceItem.sourceUri, sourceItem.locator),
        score: sourceItem.score + overlap * 0.05,
        overlap,
      };
    })
    .sort((a, b) => b.score - a.score);

  const overlapRefs = scored
    .filter((entry) => entry.overlap > 0)
    .slice(0, 2)
    .map((entry) => entry.ref);
  if (overlapRefs.length > 0) return [...new Set(overlapRefs)];
  return [];
}

function buildMinimalTasks(retrievalMode: RetrievalMode): string[] {
  switch (retrievalMode) {
    case "review_context":
      return [
        "有効なルールと手順を確認する",
        "変更内容が既知の制約に反しないか検証する",
        "指摘は根拠を明確にして優先順位順にまとめる",
      ];
    case "debug_context":
      return [
        "関連する既知手順を先に確認する",
        "原因候補を狭めてから最小変更で修正する",
        "修正箇所に絞った再現・検証を行う",
      ];
    case "architecture_context":
      return [
        "既存ルールと制約を先に確認する",
        "設計候補のトレードオフを比較する",
        "実装境界と検証方法を明確化する",
      ];
    case "procedure_context":
      return [
        "手順候補を上から順に確認する",
        "必要最小限のコマンドのみ実行する",
        "結果と次の検証ステップを記録する",
      ];
    default:
      return ["関連する知識を確認する", "安全な最小変更で実装する", "変更箇所を重点検証する"];
  }
}

function normalizeKnowledgeType(value: string): KnowledgeItem["type"] {
  return value === "procedure" ? "procedure" : "rule";
}

function normalizeKnowledgeStatus(value: string): KnowledgeStatus {
  if (value === "deprecated") return "deprecated";
  if (value === "draft") return "draft";
  return "active";
}

function toKnowledgePackItem(item: {
  id: string;
  type: KnowledgeItem["type"];
  status: KnowledgeStatus;
  title: string;
  content: string;
  score: number;
  sourceRefs: string[];
}): ContextPackItem {
  const section = item.type === "procedure" ? "procedures" : "rules";
  return {
    id: `knowledge:${item.id}`,
    itemKind: item.type,
    itemId: item.id,
    section,
    title: item.title,
    content: item.content,
    score: item.score,
    rankingReason: `ranked by weighted score (${item.status})`,
    sourceRefs: item.sourceRefs,
  };
}

type KnowledgeRankable = Rankable & {
  type: KnowledgeItem["type"];
  status: KnowledgeStatus;
  sourceRefs: string[];
  candidateEvidence?: KnowledgeCandidateEvidence;
};

type CompileReasonBuckets = {
  blockingReasons: string[];
  hardFailureReasons: string[];
  maintenanceWarnings: string[];
};

type InputFacetSummary = {
  requested: {
    changeTypes: string[];
    technologies: string[];
    domains: string[];
  };
  matched: {
    changeTypes: string[];
    technologies: string[];
    domains: string[];
  };
  unknown: {
    change_type: string[];
    technology: string[];
    domain: string[];
  };
};

function pushUnique(items: string[], value: string): void {
  if (!items.includes(value)) items.push(value);
}

function classifyCompileReasons(params: {
  reasons: string[];
  selectedKnowledgeCount: number;
}): CompileReasonBuckets {
  const uniqueReasons = [...new Set(params.reasons.map((reason) => reason.trim()).filter(Boolean))];
  const blockingReasons: string[] = [];
  const hardFailureReasons: string[] = [];
  const maintenanceWarnings: string[] = [];
  const hasKnowledge = params.selectedKnowledgeCount > 0;

  for (const reason of uniqueReasons) {
    if (maintenanceReasonSet.has(reason)) {
      maintenanceWarnings.push(reason);
      continue;
    }
    if (reason === "NO_ACTIVE_KNOWLEDGE_MATCH") {
      if (!hasKnowledge) blockingReasons.push(reason);
      continue;
    }
    if (reason === "NO_SOURCE_MATCH") {
      if (hasKnowledge) maintenanceWarnings.push(reason);
      else blockingReasons.push(reason);
      continue;
    }
    if (reason.endsWith("_FAILED") || reason.includes("ERROR")) {
      hardFailureReasons.push(reason);
      blockingReasons.push(reason);
      continue;
    }
    blockingReasons.push(reason);
  }

  return {
    blockingReasons,
    hardFailureReasons,
    maintenanceWarnings,
  };
}

function goalContainsDesignDocumentReference(goal: string): boolean {
  const trimmedGoal = goal.trim();
  if (!trimmedGoal) return false;
  return (
    designDocumentPathPattern.test(trimmedGoal) || designDocumentFileNamePattern.test(trimmedGoal)
  );
}

function isLowConfidenceVectorOnlyCandidate(evidence?: KnowledgeCandidateEvidence): boolean {
  if (!evidence?.vectorMatched) return false;
  if (evidence.textMatched || evidence.facetMatched) return false;
  const score = typeof evidence.vectorScore === "number" ? evidence.vectorScore : 0;
  return score < vectorOnlyScoreFloor;
}

function filterByCandidateEvidence(items: KnowledgeRankable[]): {
  items: KnowledgeRankable[];
  suppressedCount: number;
} {
  const selected = items.filter(
    (item) => !isLowConfidenceVectorOnlyCandidate(item.candidateEvidence),
  );
  return {
    items: selected,
    suppressedCount: Math.max(0, items.length - selected.length),
  };
}

function buildInputFacets(params: {
  input: CompileInput;
  matchedChangeTypes: string[];
  matchedTechnologies: string[];
  matchedDomains: string[];
  unknownFacetsByKind: Record<string, string[]>;
}): InputFacetSummary {
  return {
    requested: {
      changeTypes: params.input.changeTypes ?? [],
      technologies: params.input.technologies ?? [],
      domains: params.input.domains ?? [],
    },
    matched: {
      changeTypes: params.matchedChangeTypes,
      technologies: params.matchedTechnologies,
      domains: params.matchedDomains,
    },
    unknown: {
      change_type: params.unknownFacetsByKind.change_type ?? [],
      technology: params.unknownFacetsByKind.technology ?? [],
      domain: params.unknownFacetsByKind.domain ?? [],
    },
  };
}

function updateCompileRunSnapshotSafe(runId: string, pack: ContextPack): Promise<void> {
  return updateCompileRunSnapshot(runId, pack).catch(() => undefined);
}

function normalizeConfidence(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return 0.5;
  return Math.min(1, Math.max(0, numeric));
}

async function recordCompileRunKnowledgeUsageSignalsSafe(params: {
  runId: string;
  selectedKnowledgeIds: string[];
  selectedRankMap: Map<string, number>;
  agenticAcceptedKnowledgeIds: string[];
  usedKnowledge: Array<{
    id: string;
    confidence?: number;
    evidence?: string;
    outputSection?: string;
    reason?: string;
  }>;
  actor: "agent" | "system";
}): Promise<void> {
  const selectedSet = new Set(params.selectedKnowledgeIds.map((id) => id.trim()).filter(Boolean));
  if (selectedSet.size === 0) return;
  const agenticAcceptedSet = new Set(
    params.agenticAcceptedKnowledgeIds.map((id) => id.trim()).filter((id) => selectedSet.has(id)),
  );

  const usedById = new Map<
    string,
    {
      confidence: number;
      evidence?: string;
      outputSection?: string;
      reason?: string;
    }
  >();
  for (const item of params.usedKnowledge) {
    const knowledgeId = item.id.trim();
    if (!selectedSet.has(knowledgeId)) continue;
    usedById.set(knowledgeId, {
      confidence: normalizeConfidence(item.confidence),
      ...(item.evidence ? { evidence: item.evidence } : {}),
      ...(item.outputSection ? { outputSection: item.outputSection } : {}),
      ...(item.reason ? { reason: item.reason } : {}),
    });
  }

  const usageItems = [...selectedSet].map((knowledgeId) => {
    const used = usedById.get(knowledgeId);
    const selectedRank = params.selectedRankMap.get(knowledgeId);
    if (used) {
      return {
        knowledgeId,
        verdict: "used" as const,
        reason: used.reason ?? "used_by_response_composer",
        metadata: {
          source: "response_composer",
          signalSource: "context_response_composer",
          agenticAccepted: agenticAcceptedSet.has(knowledgeId),
          confidence: used.confidence,
          ...(used.evidence ? { evidence: used.evidence } : {}),
          ...(used.outputSection ? { outputSection: used.outputSection } : {}),
          ...(selectedRank ? { selectedRank } : {}),
        },
      };
    }
    return {
      knowledgeId,
      verdict: "not_used" as const,
      reason: "selected_but_not_referenced",
      metadata: {
        source: "response_composer",
        signalSource: "context_response_composer",
        agenticAccepted: agenticAcceptedSet.has(knowledgeId),
        ...(selectedRank ? { selectedRank } : {}),
      },
    };
  });

  try {
    await recordCompileRunKnowledgeUsageSignals({
      runId: params.runId,
      actor: params.actor,
      items: usageItems,
    });
  } catch (error) {
    await recordAuditLogSafe({
      eventType: "KNOWLEDGE_USAGE_SIGNAL_SAVE_FAILED",
      actor: "system",
      payload: {
        runId: params.runId,
        selectedKnowledgeIds: params.selectedKnowledgeIds,
        agenticAcceptedKnowledgeIds: params.agenticAcceptedKnowledgeIds,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeFacetArray(values: string[]): string[] {
  const deduped = new Set<string>();
  for (const value of values) {
    const normalized = value.trim().toLowerCase();
    if (!normalized) continue;
    deduped.add(normalized);
  }
  return [...deduped].sort((left, right) => left.localeCompare(right));
}

function goalHash(goal: string): string {
  return createHash("sha1").update(goal.trim()).digest("hex");
}

async function persistCompileTaskTraceSafe(params: {
  runId: string;
  retrievalMode: RetrievalMode;
  repoPath: string | null;
  repoKey: string | null;
  technologies: string[];
  changeTypes: string[];
  domains: string[];
  goal: string;
  embeddingStatus: "facets_only" | "embedding_available" | "embedding_unavailable";
  embeddingProvider: string | null;
  embeddingModel: string | null;
  embeddingDimensions: number | null;
  embedding: number[] | null;
}): Promise<void> {
  try {
    await upsertContextCompileTaskTrace({
      runId: params.runId,
      retrievalMode: params.retrievalMode,
      repoPath: params.repoPath,
      repoKey: params.repoKey,
      technologies: normalizeFacetArray(params.technologies),
      changeTypes: normalizeFacetArray(params.changeTypes),
      domains: normalizeFacetArray(params.domains),
      embeddingStatus: params.embeddingStatus,
      embeddingProvider: params.embeddingProvider,
      embeddingModel: params.embeddingModel,
      embeddingDimensions: params.embeddingDimensions,
      embedding: params.embedding,
      goalHash: goalHash(params.goal),
    });
  } catch (error) {
    await recordAuditLogSafe({
      eventType: "CONTEXT_COMPILE_TASK_TRACE_SAVE_FAILED",
      actor: "system",
      payload: {
        runId: params.runId,
        retrievalMode: params.retrievalMode,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

function resolveCandidateTraceLimit(): number {
  const raw =
    process.env.MEMORY_ROUTER_CONTEXT_COMPILE_TRACE_LIMIT ??
    process.env.CONTEXT_COMPILE_TRACE_LIMIT;
  const parsed = Number(raw ?? defaultCandidateTraceLimit);
  if (!Number.isFinite(parsed) || parsed < 1) return defaultCandidateTraceLimit;
  return Math.min(1000, Math.max(1, Math.floor(parsed)));
}

function toStageRankMap(
  entries: KnowledgeRetrievalTraceEntry[] | undefined,
): Map<string, { rank: number; score: number }> {
  const map = new Map<string, { rank: number; score: number }>();
  for (const entry of entries ?? []) {
    if (!entry.id || map.has(entry.id)) continue;
    map.set(entry.id, {
      rank: entry.rank,
      score: entry.score,
    });
  }
  return map;
}

function resolveCommunityKeyFromMetadata(metadata: unknown): string | null {
  const record = asRecord(metadata);
  const direct =
    typeof record.communityKey === "string"
      ? record.communityKey
      : typeof record.relationCommunityKey === "string"
        ? record.relationCommunityKey
        : null;
  if (direct?.trim()) return direct.trim();
  const landscape = asRecord(record.landscape);
  const fromLandscape = typeof landscape.communityKey === "string" ? landscape.communityKey : null;
  if (fromLandscape?.trim()) return fromLandscape.trim();
  return null;
}

function sortCandidateTraceRows(rows: CandidateTraceDraftRow[]): CandidateTraceDraftRow[] {
  return [...rows].sort((left, right) => {
    const leftSelected = left.selected ? 0 : 1;
    const rightSelected = right.selected ? 0 : 1;
    if (leftSelected !== rightSelected) return leftSelected - rightSelected;

    const leftFinal = left.finalRank ?? Number.MAX_SAFE_INTEGER;
    const rightFinal = right.finalRank ?? Number.MAX_SAFE_INTEGER;
    if (leftFinal !== rightFinal) return leftFinal - rightFinal;

    const leftMerged = left.mergedRank ?? Number.MAX_SAFE_INTEGER;
    const rightMerged = right.mergedRank ?? Number.MAX_SAFE_INTEGER;
    if (leftMerged !== rightMerged) return leftMerged - rightMerged;

    return left.itemId.localeCompare(right.itemId);
  });
}

function buildCandidateTraceRows(params: {
  knowledgeItems: Array<{
    id: string;
    type: KnowledgeItem["type"];
    status: KnowledgeStatus;
    score: number;
    metadata?: Record<string, unknown>;
    candidateEvidence?: KnowledgeCandidateEvidence;
  }>;
  rankedKnowledgeBeforeIntervention: KnowledgeRankable[];
  filteredKnowledge: KnowledgeRankable[];
  finalKnowledge: KnowledgeRankable[];
  selectedPackItems: ContextPackItem[];
  retrievalTrace: {
    text: KnowledgeRetrievalTraceEntry[];
    vector: KnowledgeRetrievalTraceEntry[];
    merged: KnowledgeRetrievalTraceEntry[];
  } | null;
  agenticUsed: boolean;
}): CandidateTraceDraftRow[] {
  const knowledgeById = new Map<
    string,
    {
      id: string;
      type: KnowledgeItem["type"];
      status: KnowledgeStatus;
      score: number;
      metadata?: Record<string, unknown>;
      candidateEvidence?: KnowledgeCandidateEvidence;
    }
  >();
  for (const item of params.knowledgeItems) {
    knowledgeById.set(item.id, item);
  }
  for (const item of params.rankedKnowledgeBeforeIntervention) {
    if (knowledgeById.has(item.id)) continue;
    knowledgeById.set(item.id, {
      id: item.id,
      type: item.type,
      status: item.status,
      score: item.score,
      candidateEvidence: item.candidateEvidence,
    });
  }

  const textRanks = toStageRankMap(params.retrievalTrace?.text);
  const vectorRanks = toStageRankMap(params.retrievalTrace?.vector);
  const mergedRanks = toStageRankMap(params.retrievalTrace?.merged);
  const finalRanks = new Map<string, { rank: number; score: number }>();
  for (const [index, item] of params.finalKnowledge.entries()) {
    if (finalRanks.has(item.id)) continue;
    finalRanks.set(item.id, {
      rank: index + 1,
      score: item.score,
    });
  }

  const filteredIds = new Set(params.filteredKnowledge.map((item) => item.id));
  const finalIds = new Set(params.finalKnowledge.map((item) => item.id));
  const rankedIds = new Set(params.rankedKnowledgeBeforeIntervention.map((item) => item.id));
  const selectedItemById = new Map(
    params.selectedPackItems.map((item) => [item.itemId, item.rankingReason] as const),
  );

  const candidateIds = new Set<string>();
  for (const key of textRanks.keys()) candidateIds.add(key);
  for (const key of vectorRanks.keys()) candidateIds.add(key);
  for (const key of mergedRanks.keys()) candidateIds.add(key);
  for (const key of finalRanks.keys()) candidateIds.add(key);
  for (const key of rankedIds.keys()) candidateIds.add(key);
  for (const key of selectedItemById.keys()) candidateIds.add(key);

  const rows: CandidateTraceDraftRow[] = [];
  for (const itemId of candidateIds) {
    const knowledge = knowledgeById.get(itemId);
    if (!knowledge) continue;
    const itemKind = knowledge.type === "procedure" ? "procedure" : "rule";
    const text = textRanks.get(itemId);
    const vector = vectorRanks.get(itemId);
    const merged = mergedRanks.get(itemId);
    const final = finalRanks.get(itemId);
    const selected = selectedItemById.has(itemId);

    let suppressionReason: string | null = null;
    if (!filteredIds.has(itemId) && rankedIds.has(itemId)) {
      suppressionReason = "low_confidence_vector_only";
    } else if (filteredIds.has(itemId) && !finalIds.has(itemId) && params.agenticUsed) {
      suppressionReason = "agentic_rejected";
    } else if (finalIds.has(itemId) && !selected) {
      suppressionReason = "token_budget_section_limit";
    }

    const agenticDecision: CandidateTraceDraftRow["agenticDecision"] = !params.agenticUsed
      ? "not_evaluated"
      : finalIds.has(itemId)
        ? "accepted"
        : filteredIds.has(itemId)
          ? "rejected"
          : "skipped";

    rows.push({
      itemKind,
      itemId,
      textRank: text?.rank ?? null,
      textScore: text?.score ?? null,
      vectorRank: vector?.rank ?? null,
      vectorScore: vector?.score ?? null,
      mergedRank: merged?.rank ?? null,
      mergedScore: merged?.score ?? null,
      finalRank: final?.rank ?? null,
      finalScore: final?.score ?? null,
      selected,
      suppressed: Boolean(suppressionReason),
      suppressionReason,
      agenticDecision,
      rankingReason: selectedItemById.get(itemId) ?? suppressionReason,
      communityKey: resolveCommunityKeyFromMetadata(knowledge.metadata),
      evidence: {
        status: knowledge.status,
        candidateEvidence: knowledge.candidateEvidence ?? null,
      },
    });
  }

  return sortCandidateTraceRows(rows);
}

function applyCandidateTraceLimit(
  rows: CandidateTraceDraftRow[],
  traceLimit: number,
): { rows: CandidateTraceDraftRow[]; truncated: boolean } {
  if (rows.length <= traceLimit) {
    return { rows, truncated: false };
  }

  const selectedRows = rows.filter((row) => row.selected);
  const selectedIds = new Set(selectedRows.map((row) => row.itemId));
  const remaining = rows
    .filter((row) => !selectedIds.has(row.itemId))
    .sort((left, right) => {
      const leftMerged = left.mergedRank ?? Number.MAX_SAFE_INTEGER;
      const rightMerged = right.mergedRank ?? Number.MAX_SAFE_INTEGER;
      if (leftMerged !== rightMerged) return leftMerged - rightMerged;
      const leftFinal = left.finalRank ?? Number.MAX_SAFE_INTEGER;
      const rightFinal = right.finalRank ?? Number.MAX_SAFE_INTEGER;
      if (leftFinal !== rightFinal) return leftFinal - rightFinal;
      return left.itemId.localeCompare(right.itemId);
    });

  const remainingCapacity = Math.max(0, traceLimit - selectedRows.length);
  const limited = [...selectedRows, ...remaining.slice(0, remainingCapacity)];
  return {
    rows: sortCandidateTraceRows(limited),
    truncated: limited.length < rows.length,
  };
}

async function persistCandidateTraceRows(params: {
  runId: string;
  rows: CandidateTraceDraftRow[];
  traceLimit: number;
}): Promise<{
  savedCount: number;
  truncated: boolean;
  skippedReason: string | null;
}> {
  if (params.rows.length === 0) {
    return {
      savedCount: 0,
      truncated: false,
      skippedReason: "no_candidate_rows",
    };
  }

  const limited = applyCandidateTraceLimit(params.rows, params.traceLimit);
  try {
    await insertContextCompileCandidateTraces(params.runId, limited.rows);
    return {
      savedCount: limited.rows.length,
      truncated: limited.truncated,
      skippedReason: null,
    };
  } catch (error) {
    await recordAuditLogSafe({
      eventType: "CONTEXT_COMPILE_CANDIDATE_TRACE_SAVE_FAILED",
      actor: "system",
      payload: {
        runId: params.runId,
        traceLimit: params.traceLimit,
        candidateCount: params.rows.length,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    return {
      savedCount: 0,
      truncated: false,
      skippedReason: "save_failed",
    };
  }
}

function attachOutputMarkdownToPack(pack: ContextPack, markdown: string): ContextPack {
  const retrievalStats = asRecord(pack.diagnostics.retrievalStats);
  const responseComposer = asRecord(retrievalStats.responseComposer);
  return {
    ...pack,
    diagnostics: {
      ...pack.diagnostics,
      retrievalStats: {
        ...retrievalStats,
        responseComposer: {
          ...responseComposer,
          outputMarkdown: markdown,
        },
      },
    },
  };
}

function legacyIntentFromRetrievalMode(retrievalMode: RetrievalMode): string {
  if (retrievalMode === "debug_context") return "debug";
  if (retrievalMode === "review_context") return "review";
  if (retrievalMode === "architecture_context") return "plan";
  if (retrievalMode === "procedure_context") return "edit";
  if (retrievalMode === "learning_context") return "finish";
  return "edit";
}

export async function compileContextPack(
  rawInput: unknown,
  options?: { source?: CompileRunSource },
): Promise<{
  pack: ContextPack;
  markdown: string;
}> {
  const compileStartedAt = Date.now();
  const input = compileInputSchema.parse(rawInput);
  const retrievalMode = deriveRetrievalModeFromChangeTypes(input.changeTypes);
  const workspaceRepoPath = normalizeRepoPath(process.cwd()) ?? process.cwd();
  const workspaceRepoKey =
    normalizeRepoKey(workspaceRepoPath) ?? normalizeRepoKey(process.cwd()) ?? null;
  const tokenBudget = groupedConfig.compile.defaultTokenBudget;
  const candidateTraceLimit = resolveCandidateTraceLimit();

  const normalizedApplicability = await normalizeKnowledgeApplicability({
    technologies: input.technologies,
    changeTypes: input.changeTypes,
    domains: input.domains,
  });

  const matchedTechnologies = asStringArray(normalizedApplicability.appliesTo.technologies);
  const matchedChangeTypes = asStringArray(normalizedApplicability.appliesTo.changeTypes);
  const matchedDomains = asStringArray(normalizedApplicability.appliesTo.domains);
  const unknownFacetsByKind = normalizedApplicability.unknownTagCandidates.reduce<
    Record<string, string[]>
  >((acc, candidate) => {
    const current = acc[candidate.kind] ?? [];
    if (!current.includes(candidate.value)) current.push(candidate.value);
    acc[candidate.kind] = current;
    return acc;
  }, {});

  const inputFacets = buildInputFacets({
    input,
    matchedChangeTypes,
    matchedTechnologies,
    matchedDomains,
    unknownFacetsByKind,
  });

  if (goalContainsDesignDocumentReference(input.goal)) {
    const degradedReasons = ["GOAL_CONTAINS_DESIGN_DOCUMENT_REFERENCE"];
    const compileDurationMs = Math.max(0, Date.now() - compileStartedAt);
    const reasonBuckets = classifyCompileReasons({
      reasons: degradedReasons,
      selectedKnowledgeCount: 0,
    });
    const runId = await insertCompileRun({
      goal: input.goal,
      intent: legacyIntentFromRetrievalMode(retrievalMode),
      repoPath: workspaceRepoPath,
      input: {
        goal: input.goal,
        ...(input.changeTypes ? { changeTypes: input.changeTypes } : {}),
        ...(input.technologies ? { technologies: input.technologies } : {}),
        ...(input.domains ? { domains: input.domains } : {}),
      },
      retrievalMode,
      status: "degraded",
      degradedReasons,
      tokenBudget,
      durationMs: compileDurationMs,
      source: options?.source ?? "unknown",
    });
    await persistCompileTaskTraceSafe({
      runId,
      retrievalMode,
      repoPath: workspaceRepoPath,
      repoKey: workspaceRepoKey,
      technologies: matchedTechnologies,
      changeTypes: matchedChangeTypes,
      domains: matchedDomains,
      goal: input.goal,
      embeddingStatus: "facets_only",
      embeddingProvider: null,
      embeddingModel: null,
      embeddingDimensions: null,
      embedding: null,
    });

    const pack = contextPackSchema.parse({
      runId,
      goal: input.goal,
      retrievalMode,
      status: "degraded",
      minimalTasks: buildMinimalTasks(retrievalMode),
      rules: [],
      procedures: [],
      warnings: [],
      sourceRefs: [buildFallbackSourceRef({ runId, retrievalMode, degradedReasons })],
      diagnostics: {
        degradedReasons,
        retrievalStats: {
          knowledge: { skipped: true, reason: "goal_design_document_reference" },
          sources: { skipped: true, reason: "goal_design_document_reference" },
          tokenBudget,
          compileDurationMs,
          candidateTraceSavedCount: 0,
          candidateTraceTruncated: false,
          candidateTraceLimit,
          candidateTraceSkippedReason: "goal_design_document_reference",
          agenticUsed: false,
          reasonBuckets: {
            blocking: reasonBuckets.blockingReasons,
            maintenanceWarnings: reasonBuckets.maintenanceWarnings,
            hardFailures: reasonBuckets.hardFailureReasons,
          },
          suggestedNextCalls: [],
        },
        inputFacets,
      },
    });

    const markdown = renderContextPackMarkdown(pack);
    const packWithMarkdown = attachOutputMarkdownToPack(pack, markdown);
    await updateCompileRunSnapshotSafe(runId, packWithMarkdown);
    await recordKnowledgeCompileSelectionSafe({
      runId,
      selectedKnowledgeIds: [],
      agenticAcceptedKnowledgeIds: [],
    });
    await recordAuditLogSafe({
      eventType: auditEventTypes.contextCompileRun,
      actor: "agent",
      payload: {
        runId,
        goal: input.goal,
        retrievalMode,
        status: "degraded",
        degradedReasons,
        tokenBudget,
        compileDurationMs,
        source: options?.source ?? "unknown",
        selectedCounts: { rules: 0, procedures: 0 },
      },
    });

    return { pack: packWithMarkdown, markdown };
  }

  const [knowledge, sourceContext] = await Promise.all([
    retrieveKnowledge(input, {
      retrievalMode,
      facetFilters: {
        technologies: matchedTechnologies,
        changeTypes: matchedChangeTypes,
        domains: matchedDomains,
      },
    }),
    retrieveSources(input, { retrievalMode }),
  ]);

  const degradedReasons = [...knowledge.degradedReasons, ...sourceContext.degradedReasons];

  const normalRankingLimit = 15;
  const rankedKnowledgeBeforeIntervention = rankAndDedupe<KnowledgeRankable>(
    knowledge.items.map((item) => ({
      id: item.id,
      title: item.title,
      content: item.body,
      score: item.score,
      confidence: item.confidence,
      importance: item.importance,
      dynamicScore: item.dynamicScore,
      decayFactor: item.decayFactor,
      type: normalizeKnowledgeType(item.type),
      status: normalizeKnowledgeStatus(item.status),
      sourceRefs: item.sourceRefs,
      sourceRefCount: item.sourceRefs.length,
      hasSourceLinks: item.hasSourceLinks,
      stale: item.status === "deprecated",
      applicabilityScore: item.applicabilityScore,
      candidateEvidence: item.candidateEvidence,
    })),
    isLandscapeCompileInterventionEnabled() ? 24 : normalRankingLimit,
  );
  const landscapeIntervention = applyLandscapeCompileIntervention(
    rankedKnowledgeBeforeIntervention,
    { limit: normalRankingLimit },
  );
  const rankedKnowledge = landscapeIntervention.items;

  const knowledgeFilterResult = filterByCandidateEvidence(rankedKnowledge);
  const filteredKnowledge = knowledgeFilterResult.items;
  if (knowledgeFilterResult.suppressedCount > 0) {
    pushUnique(degradedReasons, "LOW_CONFIDENCE_VECTOR_ONLY_SUPPRESSED");
  }
  if (rankedKnowledge.length > 0 && filteredKnowledge.length === 0) {
    pushUnique(degradedReasons, "NO_RELEVANT_CONTEXT");
  }

  const agenticResult = await agenticRefine(
    filteredKnowledge.map((item) => ({
      id: item.id,
      type: item.type,
      status: item.status,
      title: item.title,
      content: item.content,
      score: item.score,
      sourceRefs: item.sourceRefs,
    })),
    input,
    retrievalMode,
  );

  if (agenticResult.error) {
    console.warn(
      "[compileContextPack] agenticRefine failed, but falling back gracefully to original candidates. Error:",
      agenticResult.error,
    );
  }

  const refinedKnowledgeMap = new Map(filteredKnowledge.map((k) => [k.id, k]));
  const finalKnowledge = agenticResult.items
    .map((item) => refinedKnowledgeMap.get(item.id))
    .filter((k): k is KnowledgeRankable => k !== undefined);
  if (finalKnowledge.length === 0) {
    pushUnique(degradedReasons, "NO_RELEVANT_CONTEXT");
  }

  const packItems = finalKnowledge.map((item) => {
    const sourceRefs = selectSourceRefsForKnowledge(
      { title: item.title, content: item.content },
      sourceContext.items,
      item.sourceRefs,
    );
    return toKnowledgePackItem({
      id: item.id,
      type: item.type,
      status: item.status,
      title: item.title,
      content: item.content,
      score: item.score,
      sourceRefs,
    });
  });

  const budgetedRules = applySectionTokenBudget(
    packItems.filter((item) => item.section === "rules"),
    Math.floor(tokenBudget * sectionRatios.rules),
  );
  const budgetedProcedures = applySectionTokenBudget(
    packItems.filter((item) => item.section === "procedures"),
    Math.floor(tokenBudget * sectionRatios.procedures),
  );

  if (budgetedRules.dropped || budgetedProcedures.dropped) {
    pushUnique(degradedReasons, "TOKEN_BUDGET_SECTION_LIMIT_REACHED");
  }

  const selectedPackItems = [...budgetedRules.items, ...budgetedProcedures.items];
  const selectedKnowledgeCount = selectedPackItems.length;
  if (selectedKnowledgeCount === 0) {
    pushUnique(degradedReasons, "NO_RELEVANT_CONTEXT");
  }
  const candidateTraceRows = buildCandidateTraceRows({
    knowledgeItems: knowledge.items.map((item) => ({
      id: item.id,
      type: normalizeKnowledgeType(item.type),
      status: normalizeKnowledgeStatus(item.status),
      score: item.score,
      metadata: item.metadata,
      candidateEvidence: item.candidateEvidence,
    })),
    rankedKnowledgeBeforeIntervention,
    filteredKnowledge,
    finalKnowledge,
    selectedPackItems,
    retrievalTrace: knowledge.trace ?? null,
    agenticUsed: agenticResult.agenticUsed,
  });
  const composedResponse = await composeContextResponse({
    input,
    retrievalMode,
    rules: budgetedRules.items,
    procedures: budgetedProcedures.items,
  });
  if (composedResponse.error) {
    pushUnique(degradedReasons, "CONTEXT_RESPONSE_COMPOSE_FAILED");
  }
  if (composedResponse.markdown === "No Content" && selectedKnowledgeCount > 0) {
    pushUnique(degradedReasons, "COMPOSED_CONTEXT_NO_ALIGNMENT");
  }
  const sourceRefsCandidate = [
    ...new Set([
      ...selectedPackItems.flatMap((item) => item.sourceRefs),
      ...sourceContext.items.map((item) => formatSourceRef(item.sourceUri, item.locator)),
    ]),
  ];
  const reasonBuckets = classifyCompileReasons({
    reasons: degradedReasons,
    selectedKnowledgeCount,
  });
  const status =
    reasonBuckets.hardFailureReasons.length >= 2
      ? "failed"
      : reasonBuckets.blockingReasons.length > 0
        ? "degraded"
        : "ok";
  const minimalTasks = buildMinimalTasks(retrievalMode);
  const compileDurationMs = Math.max(0, Date.now() - compileStartedAt);
  const suggestedNextCalls: string[] = [];
  if (degradedReasons.includes("NO_ACTIVE_KNOWLEDGE_MATCH")) {
    suggestedNextCalls.push("search_knowledge");
  }
  if (degradedReasons.includes("NO_SOURCE_MATCH")) {
    suggestedNextCalls.push("search_memory");
  }
  if (
    degradedReasons.some(
      (reason) =>
        reason.endsWith("_FAILED") ||
        reason === "AGENTIC_REFINE_FAILED" ||
        reason === "QUERY_EMBEDDING_UNAVAILABLE" ||
        reason === "SOURCE_QUERY_EMBEDDING_UNAVAILABLE",
    )
  ) {
    suggestedNextCalls.push("doctor");
  }

  const runId = await insertCompileRun({
    goal: input.goal,
    intent: legacyIntentFromRetrievalMode(retrievalMode),
    repoPath: workspaceRepoPath,
    input: {
      goal: input.goal,
      ...(input.changeTypes ? { changeTypes: input.changeTypes } : {}),
      ...(input.technologies ? { technologies: input.technologies } : {}),
      ...(input.domains ? { domains: input.domains } : {}),
    },
    retrievalMode,
    status,
    degradedReasons,
    tokenBudget,
    durationMs: compileDurationMs,
    source: options?.source ?? "unknown",
  });
  const taskTraceEmbeddingStatus =
    knowledge.stats.embeddingStatus === "provided" || knowledge.stats.embeddingStatus === "generated"
      ? "embedding_available"
      : knowledge.stats.embeddingStatus === "unavailable"
        ? "embedding_unavailable"
        : "facets_only";
  await persistCompileTaskTraceSafe({
    runId,
    retrievalMode,
    repoPath: workspaceRepoPath,
    repoKey: workspaceRepoKey,
    technologies: matchedTechnologies,
    changeTypes: matchedChangeTypes,
    domains: matchedDomains,
    goal: input.goal,
    embeddingStatus: taskTraceEmbeddingStatus,
    embeddingProvider: knowledge.stats.embeddingProvider ?? null,
    embeddingModel: knowledge.stats.embeddingModel ?? null,
    embeddingDimensions: knowledge.stats.embeddingDimensions ?? null,
    embedding: knowledge.stats.queryEmbedding ?? null,
  });

  await insertContextPackItems(
    runId,
    selectedPackItems.map((item) => ({
      itemKind: item.itemKind,
      itemId: item.itemId,
      section: item.section,
      score: item.score,
      rankingReason: item.rankingReason,
      sourceRefs: item.sourceRefs,
    })),
  );
  const candidateTracePersistResult = await persistCandidateTraceRows({
    runId,
    rows: candidateTraceRows,
    traceLimit: candidateTraceLimit,
  });

  const selectedKnowledgeIds = [
    ...new Set(
      selectedPackItems
        .filter((item) => item.itemKind === "rule" || item.itemKind === "procedure")
        .map((item) => item.itemId),
    ),
  ];
  const selectedRankMap = new Map<string, number>();
  for (const [index, item] of selectedPackItems.entries()) {
    if (item.itemKind !== "rule" && item.itemKind !== "procedure") continue;
    if (selectedRankMap.has(item.itemId)) continue;
    selectedRankMap.set(item.itemId, index + 1);
  }
  const agenticAcceptedKnowledgeIds = agenticResult.agenticUsed
    ? [...new Set(finalKnowledge.map((item) => item.id))]
    : [];
  await recordKnowledgeCompileSelectionSafe({
    runId,
    selectedKnowledgeIds,
    agenticAcceptedKnowledgeIds,
  });
  await recordCompileRunKnowledgeUsageSignalsSafe({
    runId,
    selectedKnowledgeIds,
    selectedRankMap,
    agenticAcceptedKnowledgeIds,
    usedKnowledge: composedResponse.usedKnowledge,
    actor: composedResponse.agenticUsed ? "agent" : "system",
  });

  const sourceRefs =
    sourceRefsCandidate.length > 0
      ? sourceRefsCandidate
      : [buildFallbackSourceRef({ runId, retrievalMode, degradedReasons })];

  const pack = contextPackSchema.parse({
    runId,
    goal: input.goal,
    retrievalMode,
    status,
    minimalTasks,
    rules: budgetedRules.items,
    procedures: budgetedProcedures.items,
    warnings: [],
    sourceRefs,
    diagnostics: {
      degradedReasons,
      retrievalStats: {
        knowledge: knowledge.stats,
        sources: sourceContext.stats,
        tokenBudget,
        compileDurationMs,
        candidateTraceSavedCount: candidateTracePersistResult.savedCount,
        candidateTraceTruncated: candidateTracePersistResult.truncated,
        candidateTraceLimit,
        candidateTraceSkippedReason: candidateTracePersistResult.skippedReason,
        landscapeIntervention: landscapeIntervention.diagnostics,
        agenticUsed: agenticResult.agenticUsed,
        agenticReasoning: agenticResult.reasoning,
        reasonBuckets: {
          blocking: reasonBuckets.blockingReasons,
          maintenanceWarnings: reasonBuckets.maintenanceWarnings,
          hardFailures: reasonBuckets.hardFailureReasons,
        },
        responseComposer: {
          used: composedResponse.agenticUsed,
          markdownKind: composedResponse.markdown === "No Content" ? "no-content" : "narrative",
          ...(composedResponse.error ? { error: composedResponse.error } : {}),
        },
        suggestedNextCalls: [...new Set(suggestedNextCalls)],
      },
      inputFacets,
    },
  });

  const markdown = composedResponse.markdown || renderContextPackMarkdown(pack);
  const packWithMarkdown = attachOutputMarkdownToPack(pack, markdown);

  await updateCompileRunSnapshotSafe(runId, packWithMarkdown);

  await recordAuditLogSafe({
    eventType: auditEventTypes.contextCompileRun,
    actor: "agent",
    payload: {
      runId,
      goal: input.goal,
      retrievalMode,
      status,
      degradedReasons,
      tokenBudget,
      compileDurationMs,
      source: options?.source ?? "unknown",
      selectedCounts: {
        rules: budgetedRules.items.length,
        procedures: budgetedProcedures.items.length,
      },
    },
  });

  return { pack: packWithMarkdown, markdown };
}
