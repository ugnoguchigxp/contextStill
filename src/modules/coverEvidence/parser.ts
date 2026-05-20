import { parseLlmJsonLike } from "../../lib/llm-output-parser.js";
import {
  type CoverEvidenceCandidate,
  type CoverEvidenceDuplicateRef,
  type CoverEvidenceReference,
  type CoverEvidenceResult,
  type CoverEvidenceStatus,
  type CoverEvidenceToolEvent,
  type CoverEvidenceStage,
  isCoverEvidenceStatus,
  isCoverEvidenceStage,
} from "./types.js";

const MAX_REASON_LENGTH = 160;

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

function asOptionalReason(value: unknown): string | null {
  const text = asOptionalString(value)?.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, MAX_REASON_LENGTH) : null;
}

function parseScore(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100) {
    throw new Error(`${fieldName} must be an integer from 0 to 100`);
  }
  return value;
}

function parseCandidate(
  value: unknown,
  status: CoverEvidenceStatus,
): CoverEvidenceCandidate | null {
  if (value === null || value === undefined) {
    if (status === "knowledge_ready") {
      throw new Error("candidate is required when status is knowledge_ready");
    }
    return null;
  }

  const record = asRecord(value);
  const type = asString(record.type);
  if (type !== "rule" && type !== "procedure") {
    throw new Error("candidate.type must be rule or procedure");
  }
  const title = asString(record.title);
  const body = asString(record.body ?? record.content);
  if (!title || !body) {
    throw new Error("candidate.title and candidate.body are required");
  }
  return {
    type,
    title,
    body,
    importance: parseScore(record.importance, "candidate.importance"),
    confidence: parseScore(record.confidence, "candidate.confidence"),
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

export function parseCoverEvidenceResult(llmOutput: string): CoverEvidenceResult {
  const parsed = parseLlmJsonLike(llmOutput);
  if (!parsed || !parsed.value || typeof parsed.value !== "object") {
    throw new Error("coverEvidence output must be a JSON object");
  }

  const record = asRecord(parsed.value);
  const statusValue = asString(record.status);
  if (!isCoverEvidenceStatus(statusValue)) {
    throw new Error("coverEvidence status is invalid");
  }
  const status = statusValue as CoverEvidenceStatus;

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

  return {
    schemaVersion: 1,
    status,
    stage,
    candidate: parseCandidate(record.candidate, status),
    references,
    duplicateRefs,
    toolEvents,
    reason: asOptionalReason(record.reason),
  };
}
