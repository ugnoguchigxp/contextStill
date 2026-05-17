import { groupedConfig } from "../../config.js";
import {
  extractCompleteJsonValues,
  parseLlmJsonLike,
  type LlmJsonParseStrategy,
} from "../../lib/llm-output-parser.js";
import { normalizeKnowledgeScore } from "../../lib/score-scale.js";
import type { KnowledgeItem } from "../../shared/schemas/knowledge.schema.js";
import {
  distillationToolNames,
  type DistillationToolResult,
} from "./distillation-tools.service.js";

export type DistilledKnowledgeCandidate = {
  type: KnowledgeItem["type"];
  title: string;
  body: string;
  confidence: number;
  importance: number;
  confidenceProvided?: boolean;
  importanceProvided?: boolean;
  rationale?: string;
  sourceRefs?: Array<string | Record<string, unknown>>;
  evidenceRefs?: Array<string | Record<string, unknown>>;
};

export type DistillationCandidateValidationResult = {
  accepted: DistilledKnowledgeCandidate[];
  rejectedLowQuality: DistilledKnowledgeCandidate[];
  rejectedInvalidEvidence: DistilledKnowledgeCandidate[];
};

export type DistillationCandidateParseResult = {
  candidates: DistilledKnowledgeCandidate[];
  jsonRepaired: boolean;
  parseStrategies: LlmJsonParseStrategy[];
};

type DistillationCandidateValidationOptions = {
  toolEvents?: DistillationToolResult[];
  requireFetchEvidenceForUrlInput?: boolean;
};

const TOOL_CALL_NAMES = new Set<string>(distillationToolNames);
const CANDIDATE_FORMAT_LABELS = new Set([
  "type",
  "title",
  "body",
  "confidence",
  "importance",
  "optional",
  "任意",
]);
const CANDIDATE_TYPE_LABELS = new Set(["rule", "procedure"]);
const NO_CANDIDATE_RESPONSES = new Set([
  "none",
  "no candidate",
  "no candidates",
  "候補なし",
  "なし",
]);
const MIN_CANDIDATE_TITLE_CHARS = 3;
const MIN_CANDIDATE_BODY_CHARS = 24;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function hasNumericValue(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return false;
  if (typeof value === "string") return /-?\d+(?:\.\d+)?/.test(value);
  return Number.isFinite(Number(value));
}

function candidateFormatTokens(value: string): string[] {
  return value
    .trim()
    .toLowerCase()
    .replace(/[`"'“”‘’]/g, " ")
    .replace(/[()（）]/g, " ")
    .replace(/[/:：／|,]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function isCandidateFormatHeading(value: string): boolean {
  const tokens = candidateFormatTokens(value);
  if (!tokens.includes("type") || !tokens.includes("title") || !tokens.includes("body")) {
    return false;
  }
  return tokens.every((token) => CANDIDATE_FORMAT_LABELS.has(token));
}

function isStandaloneTypeLabel(value: string): boolean {
  return CANDIDATE_TYPE_LABELS.has(value.trim().toLowerCase());
}

function bodyStartsWithStandaloneTypeLine(value: string): boolean {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 1 && isStandaloneTypeLabel(lines[0] ?? "");
}

function asRefs(value: unknown): Array<string | Record<string, unknown>> | undefined {
  if (Array.isArray(value)) {
    const refs = value.filter(
      (item): item is string | Record<string, unknown> =>
        typeof item === "string" || (item && typeof item === "object" && !Array.isArray(item)),
    );
    return refs.length > 0 ? refs : undefined;
  }
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  return undefined;
}

function normalizeType(value: unknown): KnowledgeItem["type"] | undefined {
  const text = asString(value)?.toLowerCase();
  if (text?.includes("procedure")) return "procedure";
  if (text?.includes("rule")) return "rule";
  return text ? undefined : "rule";
}

function normalizeCandidateLabel(value: string): string {
  const key = value.toLowerCase();
  if (key === "自信度" || key === "信頼度") return "confidence";
  if (key === "重要度") return "importance";
  return key;
}

function deriveTitleFromBody(body: string): string {
  const firstLine =
    body
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? body.trim();
  return firstLine.slice(0, 64);
}

function normalizeCandidateFromObject(raw: unknown): DistilledKnowledgeCandidate | null {
  const record = asRecord(raw);
  if (isToolCallObject(record)) return null;

  const title = asString(record.title) ?? asString(record.heading) ?? asString(record.summary);
  const body =
    asString(record.body) ??
    asString(record.description) ??
    asString(record.content) ??
    asString(record.details);

  if (!title && !body) return null;

  const normalizedBody = (body ?? title ?? "").trim();
  const normalizedTitle = (title ?? deriveTitleFromBody(normalizedBody)).trim();
  if (!normalizedTitle || !normalizedBody) return null;

  const type = normalizeType(record.type ?? record.kind ?? record.category);
  if (!type) return null;

  return {
    type,
    title: normalizedTitle,
    body: normalizedBody,
    confidence: normalizeKnowledgeScore(record.confidence, 65),
    importance: normalizeKnowledgeScore(record.importance, 55),
    confidenceProvided: hasNumericValue(record.confidence),
    importanceProvided: hasNumericValue(record.importance),
    rationale: asString(record.rationale),
    sourceRefs: asRefs(record.sourceRefs),
    evidenceRefs: asRefs(record.evidenceRefs),
  };
}

function hasToolCallName(value: unknown): boolean {
  return asString(value) !== undefined;
}

function isToolCallObject(record: Record<string, unknown>): boolean {
  if (hasToolCallName(record.name) && record.arguments !== undefined) return true;
  const functionPayload = asRecord(record.function);
  if (hasToolCallName(functionPayload.name) && functionPayload.arguments !== undefined) return true;
  return false;
}

function filterRawCandidateItems(items: unknown[]): unknown[] {
  return items.filter((item) => !isToolCallObject(asRecord(item)));
}

function rawCandidatesFromParsedPayload(value: unknown): unknown[] {
  if (Array.isArray(value)) return filterRawCandidateItems(value);
  if (!value || typeof value !== "object") return [];
  const record = asRecord(value);
  if (isToolCallObject(record)) return [];
  if (Array.isArray(record.candidates)) return filterRawCandidateItems(record.candidates);
  if (Array.isArray(record.items)) return filterRawCandidateItems(record.items);
  if (Array.isArray(record.knowledge)) return filterRawCandidateItems(record.knowledge);
  return [record];
}

function recoverCandidatesFromTruncatedJson(text: string): {
  candidates: unknown[];
  repaired: boolean;
  strategies: LlmJsonParseStrategy[];
} {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const sources = [fenceMatch?.[1], text].filter(
    (candidate): candidate is string =>
      typeof candidate === "string" && candidate.trim().length > 0,
  );

  for (const source of sources) {
    const keyMatch = source.match(/["']?candidates["']?\s*:/i);
    if (!keyMatch || keyMatch.index === undefined) continue;
    const arrayStart = source.indexOf("[", keyMatch.index);
    if (arrayStart < 0) continue;
    const parsedObjects = extractCompleteJsonValues(source.slice(arrayStart + 1)).flatMap(
      (objectText) => {
        const parsed = parseLlmJsonLike(objectText);
        return parsed ? [parsed] : [];
      },
    );
    if (parsedObjects.length > 0) {
      return {
        candidates: parsedObjects.map((result) => result.value),
        repaired: parsedObjects.some((result) => result.repaired),
        strategies: parsedObjects.map((result) => result.strategy),
      };
    }
  }

  return { candidates: [], repaired: false, strategies: [] };
}

function parseNaturalLanguageCandidate(text: string): unknown | null {
  const normalized = text.split("\r\n").join("\n").trim();
  if (!normalized) return null;
  if (NO_CANDIDATE_RESPONSES.has(normalized.toLowerCase())) return null;
  if (
    (normalized.includes('"candidates"') || normalized.includes("'candidates'")) &&
    !/^\s*(type|title|body)\s*[:：]/im.test(normalized)
  ) {
    return null;
  }

  const fenceMatch = normalized.match(/```(?:text|md|markdown)?\s*([\s\S]*?)```/i);
  const body = (fenceMatch?.[1] ?? normalized).trim();
  if (!body) return null;

  const originalLines = body.split("\n");
  const firstContentLineIndex = originalLines.findIndex((line) => line.trim().length > 0);
  const lines =
    firstContentLineIndex >= 0 &&
    isCandidateFormatHeading(originalLines[firstContentLineIndex] ?? "")
      ? originalLines.filter((_, index) => index !== firstContentLineIndex)
      : originalLines;
  const record: Record<string, unknown> = {};
  let currentMultilineField: "body" | "rationale" | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      if (currentMultilineField === "body") {
        record.body = `${asString(record.body) ?? ""}\n`;
      }
      continue;
    }

    const labelMatch = line.match(
      /^(type|title|body|confidence|importance|自信度|信頼度|重要度|rationale|sourceRefs|evidenceRefs)\s*[:：]\s*(.*)$/i,
    );
    if (labelMatch) {
      const key = labelMatch[1] ? normalizeCandidateLabel(labelMatch[1]) : undefined;
      const value = labelMatch[2]?.trim() ?? "";
      if (!key) continue;
      if (key === "body" || key === "rationale") {
        record[key] = value;
        currentMultilineField = key;
      } else if (key === "confidence" || key === "importance") {
        record[key] = value;
        currentMultilineField = null;
      } else {
        record[key] = value;
        currentMultilineField = null;
      }
      continue;
    }

    if (currentMultilineField) {
      const current = asString(record[currentMultilineField]) ?? "";
      record[currentMultilineField] = `${current}${current ? "\n" : ""}${line}`;
      continue;
    }

    if (!record.title) {
      const prefixed = line.match(/^(rule|procedure)\s*[-:：]\s*(.+)$/i);
      if (prefixed) {
        record.type = prefixed[1];
        record.title = prefixed[2];
        continue;
      }
      record.title = line;
      continue;
    }

    const currentBody = asString(record.body) ?? "";
    record.body = `${currentBody}${currentBody ? "\n" : ""}${line}`;
  }

  return Object.keys(record).length > 0 ? record : null;
}

function extractRawCandidates(text: string): {
  candidates: unknown[];
  jsonRepaired: boolean;
  parseStrategies: LlmJsonParseStrategy[];
} {
  const jsonPayload = parseLlmJsonLike(text);
  if (jsonPayload) {
    const candidates = rawCandidatesFromParsedPayload(jsonPayload.value);
    if (candidates.length > 0) {
      return {
        candidates,
        jsonRepaired: jsonPayload.repaired,
        parseStrategies: [jsonPayload.strategy],
      };
    }
    if (jsonPayload.value && typeof jsonPayload.value === "object") {
      return {
        candidates: [],
        jsonRepaired: jsonPayload.repaired,
        parseStrategies: [jsonPayload.strategy],
      };
    }
  }

  const recoveredCandidates = recoverCandidatesFromTruncatedJson(text);
  if (recoveredCandidates.candidates.length > 0) {
    return {
      candidates: recoveredCandidates.candidates,
      jsonRepaired: recoveredCandidates.repaired,
      parseStrategies: recoveredCandidates.strategies,
    };
  }

  const naturalLanguageCandidate = parseNaturalLanguageCandidate(text);
  return {
    candidates: naturalLanguageCandidate ? [naturalLanguageCandidate] : [],
    jsonRepaired: false,
    parseStrategies: [],
  };
}

function candidateKey(candidate: DistilledKnowledgeCandidate): string {
  return `${candidate.type}\0${candidate.title.toLowerCase()}\0${candidate.body.toLowerCase()}`;
}

export function parseDistillationCandidateList(text: string): DistilledKnowledgeCandidate[] {
  return parseDistillationCandidateListWithMetadata(text).candidates;
}

export function parseDistillationCandidateListWithMetadata(
  text: string,
): DistillationCandidateParseResult {
  const byKey = new Map<string, DistilledKnowledgeCandidate>();
  const rawCandidates = extractRawCandidates(text);

  for (const rawCandidate of rawCandidates.candidates) {
    const normalized = normalizeCandidateFromObject(rawCandidate);
    if (!normalized) continue;
    byKey.set(candidateKey(normalized), normalized);
  }

  return {
    candidates: [...byKey.values()],
    jsonRepaired: rawCandidates.jsonRepaired,
    parseStrategies: rawCandidates.parseStrategies,
  };
}

export function parseDistillationCandidates(text: string): DistilledKnowledgeCandidate[] {
  return parseDistillationCandidateList(text);
}

function hasUrl(value: unknown): boolean {
  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    return normalized.includes("https://") || normalized.includes("http://");
  }
  if (Array.isArray(value)) return value.some((item) => hasUrl(item));
  if (value && typeof value === "object") return Object.values(value).some((item) => hasUrl(item));
  return false;
}

function hasSuccessfulFetch(toolEvents: DistillationToolResult[] = []): boolean {
  return toolEvents.some((event) => event.name === "fetch_content" && event.ok);
}

function normalizedTextLength(value: string): number {
  let length = 0;
  for (const char of value) {
    if (char.trim()) length += 1;
  }
  return length;
}

function isToolNameOnly(value: string): boolean {
  let normalized = value.trim().toLowerCase();
  if (
    (normalized.startsWith('"') && normalized.endsWith('"')) ||
    (normalized.startsWith("'") && normalized.endsWith("'")) ||
    (normalized.startsWith("`") && normalized.endsWith("`"))
  ) {
    normalized = normalized.slice(1, -1).trim();
  }
  if (normalized.endsWith("()")) {
    normalized = normalized.slice(0, -2).trim();
  }
  return TOOL_CALL_NAMES.has(normalized);
}

function candidateQualityIssue(candidate: DistilledKnowledgeCandidate): string | null {
  if (isToolNameOnly(candidate.title) || isToolNameOnly(candidate.body)) return "tool_name_only";
  if (isCandidateFormatHeading(candidate.title) || isCandidateFormatHeading(candidate.body)) {
    return "format_heading_only";
  }
  if (isStandaloneTypeLabel(candidate.title) || bodyStartsWithStandaloneTypeLine(candidate.body)) {
    return "type_label_only";
  }
  if (!candidate.confidenceProvided || !candidate.importanceProvided) {
    return "missing_confidence_or_importance";
  }
  if (candidate.importance < groupedConfig.distillation.minCandidateImportance) {
    return "importance_below_threshold";
  }
  const titleLength = normalizedTextLength(candidate.title);
  const bodyLength = normalizedTextLength(candidate.body);
  if (titleLength < MIN_CANDIDATE_TITLE_CHARS || bodyLength < MIN_CANDIDATE_BODY_CHARS) {
    return "too_short";
  }
  if (candidate.title.trim().toLowerCase() === candidate.body.trim().toLowerCase()) {
    return "title_body_identical";
  }
  return null;
}

function hasValidExternalEvidence(
  candidate: DistilledKnowledgeCandidate,
  toolEvents?: DistillationToolResult[],
  requireFetchEvidenceForUrlInput?: boolean,
): boolean {
  const candidateMentionsUrl =
    hasUrl(candidate.title) ||
    hasUrl(candidate.body) ||
    hasUrl(candidate.rationale) ||
    hasUrl(candidate.sourceRefs) ||
    hasUrl(candidate.evidenceRefs);
  const externalEvidenceRequired = candidateMentionsUrl || Boolean(requireFetchEvidenceForUrlInput);

  if (!externalEvidenceRequired) return true;
  return hasSuccessfulFetch(toolEvents);
}

export function validateDistillationCandidates(
  candidates: DistilledKnowledgeCandidate[],
  options: DistillationCandidateValidationOptions = {},
): DistillationCandidateValidationResult {
  const rejectedInvalidEvidence = candidates.filter(
    (candidate) =>
      !hasValidExternalEvidence(
        candidate,
        options.toolEvents,
        options.requireFetchEvidenceForUrlInput,
      ),
  );
  const invalidKeys = new Set(rejectedInvalidEvidence.map(candidateKey));
  const rejectedLowQuality = candidates.filter(
    (candidate) =>
      candidateQualityIssue(candidate) !== null && !invalidKeys.has(candidateKey(candidate)),
  );
  const accepted = candidates.filter(
    (candidate) =>
      candidateQualityIssue(candidate) === null && !invalidKeys.has(candidateKey(candidate)),
  );
  return { accepted, rejectedLowQuality, rejectedInvalidEvidence };
}

export function summarizeRejectedCandidates(
  candidates: DistilledKnowledgeCandidate[],
): Array<{ type: string; title: string; rationale?: string }> {
  return candidates.slice(0, 5).map((candidate) => ({
    type: candidate.type,
    title: candidate.title,
    rationale: candidate.rationale,
  }));
}
