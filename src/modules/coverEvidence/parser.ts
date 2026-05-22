import { parseLlmJsonLike } from "../../lib/llm-output-parser.js";
import {
  type CoverEvidenceCandidate,
  type CoverEvidenceDuplicateRef,
  type CoverEvidenceReference,
  type CoverEvidenceResult,
  type CoverEvidenceStage,
  type CoverEvidenceStatus,
  type CoverEvidenceToolEvent,
  isCoverEvidenceStage,
  isCoverEvidenceStatus,
} from "./types.js";

const MAX_REASON_LENGTH = 160;
const DEFAULT_IMPORTANCE = 70;
const DEFAULT_CONFIDENCE = 70;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asOptionalString(value: unknown): string | undefined {
  const text = asString(value);
  return text ? text : undefined;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    return value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
  }
  return [];
}

function asOptionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return undefined;
}

function asOptionalReason(value: unknown): string | null {
  const text = asOptionalString(value)?.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, MAX_REASON_LENGTH) : null;
}

function parseScore(value: unknown, fallback: number): number {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  const normalized = numeric >= 0 && numeric <= 1 ? numeric * 100 : numeric;
  return Math.max(0, Math.min(100, Math.round(normalized)));
}

function parseApplicability(
  record: Record<string, unknown>,
): Pick<
  CoverEvidenceCandidate,
  "applicabilityGeneral" | "technologies" | "changeTypes" | "domains" | "repoPath" | "repoKey"
> {
  const nested = asRecord(record.appliesTo ?? record.applicability);
  const technologies = asStringArray(record.technologies ?? nested.technologies);
  const changeTypes = asStringArray(record.changeTypes ?? nested.changeTypes);
  const domains = asStringArray(record.domains ?? nested.domains);
  const general = asOptionalBoolean(
    record.applicabilityGeneral ?? record.general ?? nested.general,
  );
  const repoPath = asOptionalString(record.repoPath ?? nested.repoPath);
  const repoKey = asOptionalString(record.repoKey ?? nested.repoKey);

  return {
    ...(general !== undefined ? { applicabilityGeneral: general } : {}),
    ...(technologies.length > 0 ? { technologies } : {}),
    ...(changeTypes.length > 0 ? { changeTypes } : {}),
    ...(domains.length > 0 ? { domains } : {}),
    ...(repoPath ? { repoPath } : {}),
    ...(repoKey ? { repoKey } : {}),
  };
}

function candidateRecordFromResult(record: Record<string, unknown>): Record<string, unknown> {
  const nested = asRecord(record.candidate);
  if (Object.keys(nested).length === 0) {
    return record;
  }
  return {
    ...record,
    ...nested,
  };
}

function inferTitleFromBody(body: string): string {
  return body.replace(/\s+/g, " ").trim().slice(0, 80);
}

function parseCandidate(record: Record<string, unknown>): CoverEvidenceCandidate | null {
  const candidateRecord = candidateRecordFromResult(record);
  const title = asString(candidateRecord.title ?? candidateRecord.candidateTitle);
  const body = asString(
    candidateRecord.body ??
      candidateRecord.content ??
      candidateRecord.candidateBody ??
      candidateRecord.candidateContent,
  );
  const normalizedTitle = title || (body ? inferTitleFromBody(body) : "");
  const normalizedBody = body || title;
  if (!normalizedTitle || !normalizedBody) {
    return null;
  }

  const type =
    asString(candidateRecord.type ?? candidateRecord.candidateType ?? candidateRecord.kind) ===
    "procedure"
      ? "procedure"
      : "rule";
  const applicability = parseApplicability(candidateRecord);
  return {
    type,
    title: normalizedTitle,
    body: normalizedBody,
    importance: parseScore(candidateRecord.importance, DEFAULT_IMPORTANCE),
    confidence: parseScore(candidateRecord.confidence, DEFAULT_CONFIDENCE),
    ...applicability,
  };
}

function parseReference(value: unknown): CoverEvidenceReference | null {
  const record = asRecord(value);
  const kind = asString(record.kind);
  if (
    kind !== "source" &&
    kind !== "web" &&
    kind !== "context7" &&
    kind !== "deepwiki" &&
    kind !== "knowledge"
  ) {
    return null;
  }
  const uri = asString(record.uri);
  const note = asString(record.note);
  const evidenceRole = asString(record.evidenceRole);
  if (
    !uri ||
    !note ||
    (evidenceRole !== "supports_candidate" &&
      evidenceRole !== "dedupe_match" &&
      evidenceRole !== "external_verification")
  ) {
    return null;
  }
  return {
    kind,
    uri,
    locator: asOptionalString(record.locator),
    title: asOptionalString(record.title),
    note,
    evidenceRole,
  };
}

function isReference(value: CoverEvidenceReference | null): value is CoverEvidenceReference {
  return value !== null;
}

function parseDuplicateRef(value: unknown): CoverEvidenceDuplicateRef | null {
  const record = asRecord(value);
  const knowledgeId = asString(record.knowledgeId ?? record.id);
  const title = asString(record.title);
  const reason = asString(record.reason);
  if (!knowledgeId || !title || !reason) return null;
  const score = Number(record.score);
  return {
    knowledgeId,
    title,
    ...(Number.isFinite(score) ? { score } : {}),
    reason,
  };
}

function isDuplicateRef(
  value: CoverEvidenceDuplicateRef | null,
): value is CoverEvidenceDuplicateRef {
  return value !== null;
}

function parseToolEvent(value: unknown): CoverEvidenceToolEvent | null {
  const record = asRecord(value);
  const name = asString(record.name);
  if (!name || typeof record.ok !== "boolean") return null;
  const metadata = asRecord(record.metadata);
  return {
    name,
    ok: record.ok,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    error: asOptionalString(record.error),
  };
}

function isToolEvent(value: CoverEvidenceToolEvent | null): value is CoverEvidenceToolEvent {
  return value !== null;
}

function parseLabelledResultRecord(text: string): Record<string, unknown> | null {
  const lines = text.split(/\r?\n/);
  const labelValues = new Map<string, string>();
  const bodyLines: string[] = [];
  let inBody = false;
  const knownLabels = new Set([
    "STATUS",
    "STAGE",
    "TYPE",
    "TITLE",
    "BODY",
    "IMPORTANCE",
    "CONFIDENCE",
    "TECHNOLOGIES",
    "CHANGE_TYPES",
    "CHANGETYPES",
    "DOMAINS",
    "DOMAIN",
    "APPLICABILITY_GENERAL",
    "GENERAL",
    "REPO_PATH",
    "REPO_KEY",
  ]);

  for (const line of lines) {
    const match = line.match(/^([A-Z_]+):\s*(.*)$/);
    if (match && knownLabels.has(match[1])) {
      const label = match[1];
      const value = match[2] ?? "";
      if (label === "BODY") {
        inBody = true;
        if (value.trim()) bodyLines.push(value);
      } else {
        inBody = false;
        labelValues.set(label, value.trim());
      }
      continue;
    }
    if (inBody) {
      bodyLines.push(line);
    }
  }

  const title = (labelValues.get("TITLE") ?? "").trim();
  const body = bodyLines.join("\n").trim();
  if (!title && !body) return null;
  const record: Record<string, unknown> = {
    ...(labelValues.get("STATUS") ? { status: labelValues.get("STATUS") } : {}),
    ...(labelValues.get("STAGE") ? { stage: labelValues.get("STAGE") } : {}),
    ...(labelValues.get("TYPE") ? { type: labelValues.get("TYPE") } : {}),
    ...(title ? { title } : {}),
    ...(body ? { body } : {}),
    ...(labelValues.get("IMPORTANCE") ? { importance: labelValues.get("IMPORTANCE") } : {}),
    ...(labelValues.get("CONFIDENCE") ? { confidence: labelValues.get("CONFIDENCE") } : {}),
    ...(labelValues.get("TECHNOLOGIES") ? { technologies: labelValues.get("TECHNOLOGIES") } : {}),
    ...(labelValues.get("CHANGE_TYPES") ? { changeTypes: labelValues.get("CHANGE_TYPES") } : {}),
    ...(labelValues.get("CHANGETYPES") ? { changeTypes: labelValues.get("CHANGETYPES") } : {}),
    ...(labelValues.get("DOMAINS") ? { domains: labelValues.get("DOMAINS") } : {}),
    ...(labelValues.get("DOMAIN") ? { domains: labelValues.get("DOMAIN") } : {}),
    ...(labelValues.get("APPLICABILITY_GENERAL")
      ? { applicabilityGeneral: labelValues.get("APPLICABILITY_GENERAL") }
      : {}),
    ...(labelValues.get("GENERAL") ? { general: labelValues.get("GENERAL") } : {}),
    ...(labelValues.get("REPO_PATH") ? { repoPath: labelValues.get("REPO_PATH") } : {}),
    ...(labelValues.get("REPO_KEY") ? { repoKey: labelValues.get("REPO_KEY") } : {}),
  };
  return record;
}

export function parseCoverEvidenceResult(llmOutput: string): CoverEvidenceResult {
  const parsed = parseLlmJsonLike(llmOutput);
  const labelledFallback = parseLabelledResultRecord(llmOutput);
  if ((!parsed || !parsed.value || typeof parsed.value !== "object") && !labelledFallback) {
    throw new Error("coverEvidence output must be a JSON object");
  }

  const record =
    parsed?.value && typeof parsed.value === "object"
      ? asRecord(parsed.value)
      : (labelledFallback ?? {});
  const statusValue = asString(record.status);
  const hasCandidateShape = Object.keys(candidateRecordFromResult(record)).some((key) =>
    ["title", "candidateTitle", "body", "content", "candidateBody", "candidateContent"].includes(
      key,
    ),
  );
  const status: CoverEvidenceStatus = isCoverEvidenceStatus(statusValue)
    ? statusValue
    : hasCandidateShape
      ? "knowledge_ready"
      : "insufficient";

  const stageValue = asString(record.stage);
  const stage: CoverEvidenceStage = isCoverEvidenceStage(stageValue) ? stageValue : "final";
  const references = Array.isArray(record.references)
    ? record.references.map(parseReference).filter(isReference)
    : [];
  const duplicateRefs = Array.isArray(record.duplicateRefs)
    ? record.duplicateRefs.map(parseDuplicateRef).filter(isDuplicateRef)
    : [];
  const toolEvents = Array.isArray(record.toolEvents)
    ? record.toolEvents.map(parseToolEvent).filter(isToolEvent)
    : [];
  const candidate = parseCandidate(record);
  const normalizedStatus: CoverEvidenceStatus =
    status === "knowledge_ready" && !candidate ? "insufficient" : status;
  const reason = asOptionalReason(record.reason);

  return {
    schemaVersion: 1,
    status: normalizedStatus,
    stage,
    candidate,
    references,
    duplicateRefs,
    toolEvents,
    reason: reason ?? (status === "knowledge_ready" && !candidate ? "candidate_missing" : null),
  };
}
