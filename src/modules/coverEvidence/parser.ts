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

export type ParseCoverEvidenceResultOptions = {
  candidateDefaults?: Partial<CoverEvidenceCandidate>;
};

const MAX_REASON_LENGTH = 160;
const DEFAULT_IMPORTANCE = 70;
const DEFAULT_CONFIDENCE = 70;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function recordValue(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
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
    const trimmed = value.trim();
    if (/^(?:n\/a|na|null|none|-|なし|\[\])$/i.test(trimmed)) {
      return [];
    }
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return parsed
            .filter((item): item is string => typeof item === "string")
            .map((item) => item.trim())
            .filter(Boolean);
        }
      } catch {
        // Local LLM sometimes emits bracketed labels like [AuthError].
      }
    }
    const normalized =
      trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
    return normalized
      .split(/[,、，]/)
      .map((part) => part.trim())
      .filter((part) => !/^(?:n\/a|na|null|none|-|なし|\[\])$/i.test(part))
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
  defaults: Partial<CoverEvidenceCandidate> = {},
): Pick<
  CoverEvidenceCandidate,
  "applicabilityGeneral" | "technologies" | "changeTypes" | "domains" | "repoPath" | "repoKey"
> {
  const nested = asRecord(
    recordValue(record, [
      "appliesTo",
      "applies_to",
      "APPLIES_TO",
      "applicability",
      "APPLICABILITY",
    ]),
  );
  const technologies = asStringArray(
    recordValue(record, ["technologies", "TECHNOLOGIES"]) ?? nested.technologies,
  );
  const changeTypes = asStringArray(
    recordValue(record, ["changeTypes", "change_types", "CHANGE_TYPES", "CHANGETYPES"]) ??
      nested.changeTypes,
  );
  const domains = asStringArray(
    recordValue(record, ["domains", "domain", "DOMAINS", "DOMAIN"]) ?? nested.domains,
  );
  const general = asOptionalBoolean(
    recordValue(record, [
      "applicabilityGeneral",
      "applicability_general",
      "APPLICABILITY_GENERAL",
      "general",
      "GENERAL",
    ]) ?? nested.general,
  );
  const repoPath = asOptionalString(
    recordValue(record, ["repoPath", "repo_path", "REPO_PATH"]) ?? nested.repoPath,
  );
  const repoKey = asOptionalString(
    recordValue(record, ["repoKey", "repo_key", "REPO_KEY"]) ?? nested.repoKey,
  );

  return {
    ...(general !== undefined
      ? { applicabilityGeneral: general }
      : defaults.applicabilityGeneral !== undefined
        ? { applicabilityGeneral: defaults.applicabilityGeneral }
        : {}),
    ...(technologies.length > 0
      ? { technologies }
      : defaults.technologies && defaults.technologies.length > 0
        ? { technologies: defaults.technologies }
        : {}),
    ...(changeTypes.length > 0
      ? { changeTypes }
      : defaults.changeTypes && defaults.changeTypes.length > 0
        ? { changeTypes: defaults.changeTypes }
        : {}),
    ...(domains.length > 0
      ? { domains }
      : defaults.domains && defaults.domains.length > 0
        ? { domains: defaults.domains }
        : {}),
    ...(repoPath ? { repoPath } : defaults.repoPath ? { repoPath: defaults.repoPath } : {}),
    ...(repoKey ? { repoKey } : defaults.repoKey ? { repoKey: defaults.repoKey } : {}),
  };
}

function candidateRecordFromResult(record: Record<string, unknown>): Record<string, unknown> {
  const nested = asRecord(recordValue(record, ["candidate", "CANDIDATE"]));
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

function parseCandidate(
  record: Record<string, unknown>,
  defaults: Partial<CoverEvidenceCandidate> = {},
  options: { useDefaults?: boolean } = {},
): CoverEvidenceCandidate | null {
  const useDefaults = options.useDefaults !== false;
  const candidateRecord = candidateRecordFromResult(record);
  const title =
    asString(
      recordValue(candidateRecord, [
        "title",
        "TITLE",
        "candidateTitle",
        "candidate_title",
        "CANDIDATE_TITLE",
      ]),
    ) || (useDefaults ? defaults.title : undefined);
  const body =
    asString(
      recordValue(candidateRecord, [
        "body",
        "BODY",
        "content",
        "CONTENT",
        "candidateBody",
        "candidate_body",
        "CANDIDATE_BODY",
        "candidateContent",
        "candidate_content",
        "CANDIDATE_CONTENT",
      ]),
    ) || (useDefaults ? defaults.body : undefined);
  const normalizedTitle = title || (body ? inferTitleFromBody(body) : "");
  const normalizedBody = body || title;
  if (!normalizedTitle || !normalizedBody) {
    return null;
  }

  const typeHint = asString(
    recordValue(candidateRecord, [
      "type",
      "TYPE",
      "candidateType",
      "candidate_type",
      "CANDIDATE_TYPE",
      "kind",
      "KIND",
    ]),
  ).toLowerCase();
  const type =
    typeHint === "procedure" ? "procedure" : ((useDefaults ? defaults.type : "rule") ?? "rule");
  const applicability = parseApplicability(candidateRecord, useDefaults ? defaults : {});
  return {
    type,
    title: normalizedTitle,
    body: normalizedBody,
    importance: parseScore(
      recordValue(candidateRecord, ["importance", "IMPORTANCE"]),
      useDefaults ? (defaults.importance ?? DEFAULT_IMPORTANCE) : DEFAULT_IMPORTANCE,
    ),
    confidence: parseScore(
      recordValue(candidateRecord, ["confidence", "CONFIDENCE"]),
      useDefaults ? (defaults.confidence ?? DEFAULT_CONFIDENCE) : DEFAULT_CONFIDENCE,
    ),
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
    "REASON",
  ]);
  const canonicalLabel = (value: string): string | null => {
    const normalized = value
      .trim()
      .replace(/([a-z])([A-Z])/g, "$1_$2")
      .replace(/[\s-]+/g, "_")
      .toUpperCase();
    return knownLabels.has(normalized) ? normalized : null;
  };
  let currentLabel: string | null = null;
  const currentValueLines: string[] = [];

  const flushCurrentLabel = () => {
    if (!currentLabel) return;
    const value = currentValueLines.join("\n").trim();
    if (value || currentLabel === "BODY") {
      labelValues.set(currentLabel, value);
    }
    currentLabel = null;
    currentValueLines.length = 0;
  };

  for (const line of lines) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_\-\s]*):\s*(.*)$/);
    const matchedLabel = match ? canonicalLabel(match[1] ?? "") : null;
    if (match && matchedLabel) {
      flushCurrentLabel();
      const value = match[2] ?? "";
      currentLabel = matchedLabel;
      if (value.trim()) currentValueLines.push(value);
      continue;
    }
    const bareLabel = canonicalLabel(line);
    if (bareLabel) {
      flushCurrentLabel();
      currentLabel = bareLabel;
      continue;
    }
    if (currentLabel) {
      currentValueLines.push(line);
    }
  }
  flushCurrentLabel();

  const title = (labelValues.get("TITLE") ?? "").trim();
  const body = (labelValues.get("BODY") ?? "").trim();
  const status = (labelValues.get("STATUS") ?? "").trim();
  const reason = (labelValues.get("REASON") ?? "").trim();
  if (!title && !body && !status && !reason) return null;
  const record: Record<string, unknown> = {
    ...(status ? { status } : {}),
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
    ...(reason ? { reason } : {}),
  };
  return record;
}

const slashKnownLabels = new Set([
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
  "REASON",
]);

function normalizeSlashValue(value: string | undefined): string {
  const normalized = (value ?? "").trim();
  return /^(?:n\/a|na|null|none|-|なし)$/i.test(normalized) ? "" : normalized;
}

function assignLabelValue(record: Record<string, unknown>, label: string, value: string): void {
  const normalized = normalizeSlashValue(value);
  if (!normalized) return;
  switch (label) {
    case "STATUS":
      record.status = normalized;
      return;
    case "STAGE":
      record.stage = normalized;
      return;
    case "TYPE":
      record.type = normalized;
      return;
    case "TITLE":
      record.title = normalized;
      return;
    case "BODY":
      record.body = normalized;
      return;
    case "IMPORTANCE":
      record.importance = normalized;
      return;
    case "CONFIDENCE":
      record.confidence = normalized;
      return;
    case "TECHNOLOGIES":
      record.technologies = normalized;
      return;
    case "CHANGE_TYPES":
    case "CHANGETYPES":
      record.changeTypes = normalized;
      return;
    case "DOMAINS":
    case "DOMAIN":
      record.domains = normalized;
      return;
    case "APPLICABILITY_GENERAL":
    case "GENERAL":
      record.applicabilityGeneral = normalized;
      return;
    case "REPO_PATH":
      record.repoPath = normalized;
      return;
    case "REPO_KEY":
      record.repoKey = normalized;
      return;
    case "REASON":
      record.reason = normalized;
      return;
  }
}

function normalizeSlashLabel(value: string): string | null {
  const normalized = value
    .trim()
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toUpperCase();
  return slashKnownLabels.has(normalized) ? normalized : null;
}

function parseMixedSlashResultRecord(text: string): Record<string, unknown> | null {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact.includes("/")) return null;
  const tokens = compact
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  if (tokens.length < 2) return null;
  if (tokens.every((token) => normalizeSlashLabel(token))) return null;

  const record: Record<string, unknown> = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    const lower = token.toLowerCase();
    if (!record.type && (lower === "rule" || lower === "procedure")) {
      record.type = lower;
      continue;
    }
    if (!record.status && isCoverEvidenceStatus(lower)) {
      record.status = lower;
      continue;
    }
    if (
      !record.status &&
      (lower === "success" || lower === "ok") &&
      isCoverEvidenceStatus((tokens[index + 1] ?? "").toLowerCase())
    ) {
      record.status = (tokens[index + 1] ?? "").toLowerCase();
      index += 1;
      continue;
    }
    if (!record.stage && isCoverEvidenceStage(lower)) {
      record.stage = lower;
      continue;
    }

    const label = normalizeSlashLabel(token);
    if (!label) continue;
    assignLabelValue(record, label, tokens[index + 1] ?? "");
    index += 1;
  }

  return record.status || record.type || record.title || record.body || record.reason
    ? record
    : null;
}

function parseSlashResultRecord(text: string): Record<string, unknown> | null {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact.includes("/")) return null;
  const tokens = compact
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  if (tokens.length < 2) return null;
  if (tokens.every((token) => slashKnownLabels.has(token.toUpperCase()))) return null;

  const record: Record<string, unknown> = {};
  for (let index = 0; index < tokens.length - 1; index += 2) {
    const label = tokens[index]?.toUpperCase();
    if (!label || !slashKnownLabels.has(label)) {
      break;
    }
    assignLabelValue(record, label, tokens[index + 1] ?? "");
  }

  if (Object.keys(record).length > 1) {
    return record;
  }

  if (tokens[0]?.toUpperCase() !== "STATUS") return null;
  const status = asString(record.status) || normalizeSlashValue(tokens[1]);
  if (!isCoverEvidenceStatus(status)) return null;
  record.status = status;
  const remaining = tokens.slice(2).map(normalizeSlashValue).filter(Boolean);
  if (status === "insufficient" && remaining.length > 0) {
    record.reason = remaining[remaining.length - 1];
  }
  return record;
}

function parseSlashTableResultRecord(text: string): Record<string, unknown> | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const headerIndex = lines.findIndex((line) => {
    if (!line.includes("/")) return false;
    const labels = line
      .split("/")
      .map((part) => part.trim().toUpperCase())
      .filter(Boolean);
    return labels.length > 1 && labels.every((label) => slashKnownLabels.has(label));
  });
  if (headerIndex < 0) return null;
  const valueLine = lines.slice(headerIndex + 1).find((line) => line.includes("/"));
  if (!valueLine) return null;

  const labels = lines[headerIndex]
    ?.split("/")
    .map((part) => part.trim().toUpperCase())
    .filter(Boolean);
  const values = valueLine.split("/").map((part) => part.trim());
  while (values[0] === "") values.shift();
  while (values[values.length - 1] === "") values.pop();
  if (!labels || labels.length < 2 || values.length < 2) return null;

  const record: Record<string, unknown> = {};
  for (let index = 0; index < Math.min(labels.length, values.length); index += 1) {
    assignLabelValue(record, labels[index] ?? "", values[index] ?? "");
  }
  if (!record.status && !record.title && !record.body && !record.reason) return null;
  return record;
}

function isSlashHeaderLine(line: string): boolean {
  if (!line.includes("/")) return false;
  const labels = line
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  return labels.length > 1 && labels.every((label) => Boolean(normalizeSlashLabel(label)));
}

function parseTitleBodyFinalMetadataRecord(text: string): Record<string, unknown> | null {
  const lines = text.split(/\r?\n/);
  let metadataIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    const previousNonEmptyLine = lines
      .slice(0, index)
      .reverse()
      .find((candidateLine) => candidateLine.trim());
    if (previousNonEmptyLine && isSlashHeaderLine(previousNonEmptyLine)) {
      continue;
    }
    if (line.includes("/") && (parseSlashResultRecord(line) || parseMixedSlashResultRecord(line))) {
      metadataIndex = index;
      break;
    }
  }
  if (metadataIndex <= 0) return null;
  const contentLines = lines.slice(0, metadataIndex);
  const titleIndex = contentLines.findIndex((line) => line.trim().length > 0);
  if (titleIndex < 0) return null;

  const title = contentLines[titleIndex]?.trim() ?? "";
  const body = contentLines
    .slice(titleIndex + 1)
    .join("\n")
    .trim();
  const metadata =
    parseSlashResultRecord(lines[metadataIndex] ?? "") ??
    parseMixedSlashResultRecord(lines[metadataIndex] ?? "") ??
    {};
  if (!title && !body) return null;
  return {
    ...metadata,
    ...(title ? { title } : {}),
    ...(body ? { body } : {}),
  };
}

function parseStatusOnlyResultRecord(text: string): Record<string, unknown> | null {
  const normalized = text
    .trim()
    .replace(/[:/]+$/, "")
    .toLowerCase();
  if (
    normalized !== "knowledge_ready" &&
    normalized !== "insufficient" &&
    normalized !== "duplicate" &&
    normalized !== "near_duplicate"
  ) {
    return null;
  }
  return { status: normalized };
}

export function parseCoverEvidenceResult(
  llmOutput: string,
  options: ParseCoverEvidenceResultOptions = {},
): CoverEvidenceResult {
  const parsed = parseLlmJsonLike(llmOutput);
  const titleBodyMetadataFallback = parseTitleBodyFinalMetadataRecord(llmOutput);
  const labelledFallback = titleBodyMetadataFallback ? null : parseLabelledResultRecord(llmOutput);
  const slashFallback =
    titleBodyMetadataFallback || labelledFallback
      ? null
      : (parseSlashTableResultRecord(llmOutput) ??
        parseSlashResultRecord(llmOutput) ??
        parseMixedSlashResultRecord(llmOutput));
  const statusOnlyFallback =
    titleBodyMetadataFallback || labelledFallback || slashFallback
      ? null
      : parseStatusOnlyResultRecord(llmOutput);
  if (
    (!parsed || !parsed.value || typeof parsed.value !== "object") &&
    !titleBodyMetadataFallback &&
    !labelledFallback &&
    !slashFallback &&
    !statusOnlyFallback
  ) {
    throw new Error("coverEvidence output must be a JSON object");
  }

  const record =
    parsed?.value && typeof parsed.value === "object" && !Array.isArray(parsed.value)
      ? asRecord(parsed.value)
      : (titleBodyMetadataFallback ??
        labelledFallback ??
        slashFallback ??
        statusOnlyFallback ??
        {});
  const statusValue = asString(recordValue(record, ["status", "STATUS"])).toLowerCase();
  const status: CoverEvidenceStatus = isCoverEvidenceStatus(statusValue)
    ? statusValue
    : parseCandidate(record, {}, { useDefaults: false })
      ? "knowledge_ready"
      : "insufficient";
  const candidate =
    status === "knowledge_ready" ? parseCandidate(record, options.candidateDefaults) : null;

  const stageValue = asString(recordValue(record, ["stage", "STAGE"])).toLowerCase();
  const stage: CoverEvidenceStage = isCoverEvidenceStage(stageValue) ? stageValue : "final";
  const rawReferences = recordValue(record, ["references", "REFERENCES"]);
  const references = Array.isArray(rawReferences)
    ? rawReferences.map(parseReference).filter(isReference)
    : [];
  const rawDuplicateRefs = recordValue(record, [
    "duplicateRefs",
    "duplicate_refs",
    "DUPLICATE_REFS",
  ]);
  const duplicateRefs = Array.isArray(rawDuplicateRefs)
    ? rawDuplicateRefs.map(parseDuplicateRef).filter(isDuplicateRef)
    : [];
  const rawToolEvents = recordValue(record, ["toolEvents", "tool_events", "TOOL_EVENTS"]);
  const toolEvents = Array.isArray(rawToolEvents)
    ? rawToolEvents.map(parseToolEvent).filter(isToolEvent)
    : [];
  const normalizedStatus: CoverEvidenceStatus =
    status === "knowledge_ready" && !candidate ? "insufficient" : status;
  const reason = asOptionalReason(recordValue(record, ["reason", "REASON"]));

  return {
    schemaVersion: 1,
    status: normalizedStatus,
    stage,
    candidate,
    references,
    duplicateRefs,
    toolEvents,
    reason:
      reason ??
      (status === "knowledge_ready" && !candidate
        ? "candidate_missing"
        : normalizedStatus === "insufficient"
          ? "insufficient"
          : null),
  };
}
