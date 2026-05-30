import { groupedConfig } from "../../config.js";
import {
  PROCEDURE_BODY_NOT_ACTIONABLE_REASON,
  assessProcedureQuality,
  hasProcedureWorkflowSignal,
  validateCandidateQualityForStorage,
} from "../distillation/procedure-quality.js";
import { buildProcedureSystemContext } from "../distillation/procedure-system-context.js";
import type { CandidateKnowledgeType } from "../findCandidate/repository.js";
import { referencesFromMcpToolEvents } from "./mcp-evidence.service.js";
import type {
  CoverEvidenceCandidate,
  CoverEvidenceCandidateInput,
  CoverEvidenceReference,
  CoverEvidenceResult,
  CoverEvidenceStage,
  CoverEvidenceStatus,
  CoverEvidenceToolEvent,
} from "./types.js";

export type CoverEvidenceSourceContext = {
  targetKind: CoverEvidenceCandidateInput["targetKind"];
  targetKey: string;
  sourceUri: string;
  readRanges: Array<{ from: number; toExclusive: number }>;
  sourceSummary?: string;
};

export type CandidateOriginHints = Partial<
  Pick<
    CoverEvidenceCandidate,
    | "type"
    | "importance"
    | "confidence"
    | "applicabilityGeneral"
    | "technologies"
    | "changeTypes"
    | "domains"
    | "repoPath"
    | "repoKey"
  >
>;

const MAX_REASON_LENGTH = 160;

export function compactReason(value: string | null | undefined): string | null {
  const reason = value?.replace(/\s+/g, " ").trim();
  return reason ? reason.slice(0, MAX_REASON_LENGTH) : null;
}

export function procedureBodyInstructions(): string[] {
  return buildProcedureSystemContext().split("\n");
}

export function applicabilityInstructions(): string[] {
  return [
    "draft knowledge の applicability metadata を最終 JSON に返してください。",
    "ネストした appliesTo や candidate オブジェクトは作らないでください。",
    "任意 field は applicabilityGeneral, technologies, changeTypes, domains, repoPath, repoKey です。",
    "technologies / changeTypes / domains は JSON 配列ではなく、できればカンマ区切り文字列で返してください。",
    "knowledge_ready を返す場合、technologies/changeTypes/domains はそれぞれ最低 1 件を必ず埋めてください。",
    "3カテゴリを埋められない場合は knowledge_ready にせず、status=insufficient と reason=applies_to_categories_required を返してください。",
    "source evidence から明確に言える値を優先し、曖昧な推測で埋めないでください。",
    "applicabilityGeneral は repo、project、file、technology に依存せず広く再利用できる knowledge の場合だけ true にしてください。",
    "repoPath と repoKey は system/source metadata に明示されている場合だけ使い、推測で作らないでください。",
  ];
}

export function sourceContextForPrompts(params: {
  row: CoverEvidenceCandidateInput;
  readRanges: Array<{ from: number; toExclusive: number }>;
}): CoverEvidenceSourceContext {
  const originRecord =
    params.row.origin && typeof params.row.origin === "object" && !Array.isArray(params.row.origin)
      ? (params.row.origin as Record<string, unknown>)
      : null;
  const sourceSummary =
    typeof originRecord?.sourceSummary === "string" && originRecord.sourceSummary.trim().length > 0
      ? originRecord.sourceSummary.trim()
      : undefined;
  return {
    targetKind: params.row.targetKind,
    targetKey: params.row.targetKey,
    sourceUri: params.row.sourceUri,
    readRanges: params.readRanges,
    ...(sourceSummary ? { sourceSummary } : {}),
  };
}

export function candidateTypeFromOrigin(origin: unknown): CandidateKnowledgeType | undefined {
  if (!origin || typeof origin !== "object" || Array.isArray(origin)) return undefined;
  const record = origin as { candidateType?: unknown; type?: unknown; typeHint?: unknown };
  const value = record.candidateType ?? record.typeHint ?? record.type;
  if (value === "rule" || value === "procedure") return value;
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function scoreHint(value: unknown): number | undefined {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(numeric)) return undefined;
  const normalized = numeric >= 0 && numeric <= 1 ? numeric * 100 : numeric;
  return Math.max(0, Math.min(100, Math.round(normalized)));
}

function booleanHint(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return undefined;
}

function stringHint(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArrayHint(value: unknown): string[] | undefined {
  const values = Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
    : typeof value === "string" && value.trim()
      ? value
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean)
      : [];
  return values.length > 0 ? [...new Set(values)] : undefined;
}

export function candidateOriginHintsFromOrigin(origin: unknown): CandidateOriginHints {
  const record = asRecord(origin);
  const appliesTo = asRecord(record.appliesTo ?? record.applicability);
  const type = candidateTypeFromOrigin(origin);
  const importance = scoreHint(record.importance);
  const confidence = scoreHint(record.confidence);
  const applicabilityGeneral = booleanHint(
    record.applicabilityGeneral ?? record.general ?? appliesTo.general,
  );
  const technologies = stringArrayHint(record.technologies ?? appliesTo.technologies);
  const changeTypes = stringArrayHint(record.changeTypes ?? appliesTo.changeTypes);
  const domains = stringArrayHint(record.domains ?? appliesTo.domains);
  const repoPath = stringHint(record.repoPath ?? appliesTo.repoPath);
  const repoKey = stringHint(record.repoKey ?? appliesTo.repoKey);

  return {
    ...(type ? { type } : {}),
    ...(importance !== undefined ? { importance } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    ...(applicabilityGeneral !== undefined ? { applicabilityGeneral } : {}),
    ...(technologies ? { technologies } : {}),
    ...(changeTypes ? { changeTypes } : {}),
    ...(domains ? { domains } : {}),
    ...(repoPath ? { repoPath } : {}),
    ...(repoKey ? { repoKey } : {}),
  };
}

export function inferCandidateType(
  title: string,
  body: string,
  typeHint?: CandidateKnowledgeType,
): CoverEvidenceCandidate["type"] {
  if (typeHint === "rule") return "rule";
  if (typeHint === "procedure" && hasProcedureWorkflowSignal(title, body)) return "procedure";
  if (hasProcedureWorkflowSignal(title, body)) {
    return "procedure";
  }
  return "rule";
}

export function reclassifyCandidate(candidate: CoverEvidenceCandidate): CoverEvidenceCandidate {
  if (candidate.type === "procedure") return candidate;
  const inferred = inferCandidateType(candidate.title, candidate.body);
  return inferred === "procedure" ? { ...candidate, type: "procedure" } : candidate;
}

export function reclassifyResultCandidate(result: CoverEvidenceResult): CoverEvidenceResult {
  if (!result.candidate) return result;
  const candidate = reclassifyCandidate(result.candidate);
  return candidate === result.candidate ? result : { ...result, candidate };
}

export function inferImportance(title: string, body: string): number {
  const text = `${title}\n${body}`.toLowerCase();
  if (
    /(must|never|required|failure|error|security|verify|必ず|禁止|失敗|エラー|検証|安全)/i.test(
      text,
    )
  ) {
    return 82;
  }
  if (/(should|prefer|avoid|推奨|避ける|注意)/i.test(text)) {
    return 74;
  }
  return 68;
}

export function baseCandidate(params: {
  title: string;
  body: string;
  confidence: number;
  hints?: CandidateOriginHints;
}): CoverEvidenceCandidate {
  const hints = params.hints ?? {};
  return {
    type: inferCandidateType(params.title, params.body, hints.type),
    title: params.title,
    body: params.body,
    importance: hints.importance ?? inferImportance(params.title, params.body),
    confidence: hints.confidence ?? Math.max(0, Math.min(100, Math.round(params.confidence))),
    ...(hints.applicabilityGeneral !== undefined
      ? { applicabilityGeneral: hints.applicabilityGeneral }
      : {}),
    ...(hints.technologies && hints.technologies.length > 0
      ? { technologies: hints.technologies }
      : {}),
    ...(hints.changeTypes && hints.changeTypes.length > 0
      ? { changeTypes: hints.changeTypes }
      : {}),
    ...(hints.domains && hints.domains.length > 0 ? { domains: hints.domains } : {}),
    ...(hints.repoPath ? { repoPath: hints.repoPath } : {}),
    ...(hints.repoKey ? { repoKey: hints.repoKey } : {}),
  };
}

export function toolEventsForResult(events: unknown[]): CoverEvidenceToolEvent[] {
  return events
    .map((event) => {
      if (!event || typeof event !== "object") return null;
      const record = event as {
        name?: unknown;
        ok?: unknown;
        metadata?: unknown;
        error?: unknown;
      };
      if (typeof record.name !== "string" || typeof record.ok !== "boolean") return null;
      const metadata =
        record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata)
          ? (record.metadata as Record<string, unknown>)
          : undefined;
      return {
        name: record.name,
        ok: record.ok,
        ...(metadata ? { metadata } : {}),
        ...(typeof record.error === "string" ? { error: record.error } : {}),
      };
    })
    .filter((event): event is CoverEvidenceToolEvent => Boolean(event));
}

export function referenceKey(reference: CoverEvidenceReference): string {
  return [reference.kind, reference.uri, reference.locator ?? "", reference.evidenceRole].join(
    "\0",
  );
}

export function mergeReferences(...groups: CoverEvidenceReference[][]): CoverEvidenceReference[] {
  const byKey = new Map<string, CoverEvidenceReference>();
  for (const reference of groups.flat()) {
    byKey.set(referenceKey(reference), reference);
  }
  return [...byKey.values()];
}

export function referencesFromDuplicateRefs(
  duplicateRefs: CoverEvidenceResult["duplicateRefs"],
): CoverEvidenceReference[] {
  return duplicateRefs.map((ref) => ({
    kind: "knowledge",
    uri: `knowledge://${ref.knowledgeId}`,
    title: ref.title,
    note: ref.reason,
    evidenceRole: "dedupe_match",
  }));
}

export function referencesFromToolEvents(
  toolEvents: CoverEvidenceToolEvent[],
): CoverEvidenceReference[] {
  const webReferences = toolEvents
    .filter((event) => event.ok)
    .flatMap((event): CoverEvidenceReference[] => {
      const metadata = event.metadata ?? {};
      if (event.name === "fetch_content") {
        if (Array.isArray(metadata.selectedUrls)) {
          return metadata.selectedUrls
            .filter((uri): uri is string => typeof uri === "string" && uri.trim().length > 0)
            .map((uri) => ({
              kind: "web" as const,
              uri,
              note: "fetch_content verified external evidence",
              evidenceRole: "external_verification" as const,
            }));
        }
        const uri =
          typeof metadata.finalUrl === "string"
            ? metadata.finalUrl
            : typeof metadata.url === "string"
              ? metadata.url
              : "";
        if (!uri) return [];
        return [
          {
            kind: "web",
            uri,
            note: "fetch_content verified external evidence",
            evidenceRole: "external_verification",
          },
        ];
      }
      if (event.name === "search_web" && typeof metadata.query === "string") {
        return [
          {
            kind: "web",
            uri: `search:${metadata.query}`,
            note: "search_web located external evidence candidates",
            evidenceRole: "external_verification",
          },
        ];
      }
      return [];
    })
    .filter((reference): reference is CoverEvidenceReference => Boolean(reference));
  return [...webReferences, ...referencesFromMcpToolEvents(toolEvents)];
}

export function makeResult(params: {
  status: CoverEvidenceStatus;
  stage: CoverEvidenceStage;
  candidate: CoverEvidenceCandidate | null;
  references?: CoverEvidenceReference[];
  duplicateRefs?: CoverEvidenceResult["duplicateRefs"];
  toolEvents?: CoverEvidenceToolEvent[];
  reason?: string | null;
}): CoverEvidenceResult {
  const reason = compactReason(params.reason);
  return {
    schemaVersion: 1,
    status: params.status,
    stage: params.stage,
    candidate: params.candidate,
    references: params.references ?? [],
    duplicateRefs: params.duplicateRefs ?? [],
    toolEvents: params.toolEvents ?? [],
    reason: reason ?? (params.status === "insufficient" ? "insufficient" : null),
  };
}

export function normalizeProcedureBodyQuality(
  result: CoverEvidenceResult,
  options: { typeHint?: CandidateKnowledgeType } = {},
): CoverEvidenceResult {
  if (result.status !== "knowledge_ready" || !result.candidate) {
    return result;
  }
  if (result.candidate.type === "rule") {
    const validation = validateCandidateQualityForStorage(result.candidate, {
      typeHint: options.typeHint,
    });
    if (validation.action === "accept") return result;
    return makeResult({
      status: "insufficient",
      stage: result.stage,
      candidate: null,
      references: result.references,
      duplicateRefs: result.duplicateRefs,
      toolEvents: result.toolEvents,
      reason: validation.reason,
    });
  }
  const decision = assessProcedureQuality({
    title: result.candidate.title,
    body: result.candidate.body,
    typeHint: options.typeHint,
  });
  if (decision.action === "accept_procedure") return result;
  if (decision.action === "demote_to_rule") {
    const demotionEvent: CoverEvidenceToolEvent = {
      name: "procedure_demoted_to_rule",
      ok: true,
      metadata: {
        reason: decision.reason,
        typeHint: options.typeHint ?? null,
      },
    };
    const hasDemotionEvent = result.toolEvents.some(
      (event) => event.name === demotionEvent.name && event.ok,
    );
    return {
      ...result,
      candidate: {
        ...result.candidate,
        type: "rule",
      },
      toolEvents: hasDemotionEvent ? result.toolEvents : [...result.toolEvents, demotionEvent],
    };
  }
  return makeResult({
    status: "insufficient",
    stage: result.stage,
    candidate: null,
    references: result.references,
    duplicateRefs: result.duplicateRefs,
    toolEvents: result.toolEvents,
    reason:
      decision.action === "reject_insufficient"
        ? decision.reason
        : PROCEDURE_BODY_NOT_ACTIONABLE_REASON,
  });
}

export function rejectLowImportance(result: CoverEvidenceResult): CoverEvidenceResult {
  if (
    result.status !== "knowledge_ready" ||
    !result.candidate ||
    result.candidate.importance > groupedConfig.distillation.lowImportanceRejectThreshold
  ) {
    return result;
  }
  return makeResult({
    status: "insufficient",
    stage: result.stage,
    candidate: null,
    references: result.references,
    duplicateRefs: result.duplicateRefs,
    toolEvents: result.toolEvents,
    reason: "low_importance",
  });
}

const retryableCoverEvidenceStatuses = new Set<CoverEvidenceStatus>([
  "reprocess_requested",
  "tool_failed",
  "provider_failed",
  "parse_failed",
]);

export function isRetryableCoverEvidenceStatus(status: CoverEvidenceStatus): boolean {
  return retryableCoverEvidenceStatuses.has(status);
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

const externalEvidenceUrlPattern = /\bhttps?:\/\//i;
const directExternalEvidenceKeywordPattern =
  /\b(pricing|rate limits?|official docs?|official documentation|public docs?|public documentation|public spec(?:ification)?s?)\b/i;
const externalEvidenceFreshnessPattern = /\b(latest|current|currently|up-to-date)\b/i;
const externalEvidenceSubjectPattern =
  /\b(api|docs?|documentation|reference|spec(?:ification)?s?|provider|models?|package|library|sdk)\b/i;
const japaneseDirectExternalEvidenceKeywordPattern =
  /(料金|レート制限|公開仕様|公式ドキュメント|公式資料)/i;
const japaneseExternalEvidenceFreshnessPattern = /(現在|最新)/i;
const japaneseExternalEvidenceSubjectPattern =
  /(API|ドキュメント|仕様|資料|モデル名|パッケージ|ライブラリ)/i;

export function requiresExternalEvidence(candidate: CoverEvidenceCandidate): boolean {
  const text = `${candidate.title}\n${candidate.body}`;
  return (
    externalEvidenceUrlPattern.test(text) ||
    directExternalEvidenceKeywordPattern.test(text) ||
    japaneseDirectExternalEvidenceKeywordPattern.test(text) ||
    (externalEvidenceFreshnessPattern.test(text) && externalEvidenceSubjectPattern.test(text)) ||
    (japaneseExternalEvidenceFreshnessPattern.test(text) &&
      japaneseExternalEvidenceSubjectPattern.test(text))
  );
}
