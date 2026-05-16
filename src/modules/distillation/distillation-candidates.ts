import { groupedConfig } from "../../config.js";
import {
  extractCompleteJsonValues,
  parseLlmJsonLike,
  type LlmJsonParseStrategy,
} from "../../lib/llm-output-parser.js";
import { normalizeKnowledgeScore } from "../../lib/score-scale.js";
import type { KnowledgeItem } from "../../shared/schemas/knowledge.schema.js";
import type { DistillationToolResult } from "./distillation-tools.service.js";

export type DistilledKnowledgeCandidate = {
  type: KnowledgeItem["type"];
  title: string;
  body: string;
  confidence: number;
  importance: number;
  score: number;
  rationale?: string;
  sourceRefs?: Array<string | Record<string, unknown>>;
  evidenceRefs?: Array<string | Record<string, unknown>>;
};

export type DistillationScoreGateResult = {
  accepted: DistilledKnowledgeCandidate[];
  rejectedLowScore: DistilledKnowledgeCandidate[];
  rejectedInvalidEvidence: DistilledKnowledgeCandidate[];
  threshold: number;
};

export type DistillationCandidateParseResult = {
  candidates: DistilledKnowledgeCandidate[];
  jsonRepaired: boolean;
  parseStrategies: LlmJsonParseStrategy[];
};

type DistillationScoreGateOptions = {
  toolEvents?: DistillationToolResult[];
  requireFetchEvidenceForUrlInput?: boolean;
};

function clamp01(value: unknown, fallback: number): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(1, Math.max(0, num));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
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
  const title =
    asString(record.title) ??
    asString(record.name) ??
    asString(record.heading) ??
    asString(record.summary);
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
    score: clamp01(record.score, groupedConfig.distillationTools.minCandidateScore),
    rationale: asString(record.rationale),
    sourceRefs: asRefs(record.sourceRefs),
    evidenceRefs: asRefs(record.evidenceRefs),
  };
}

function rawCandidatesFromParsedPayload(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  const record = asRecord(value);
  if (Array.isArray(record.candidates)) return record.candidates;
  if (Array.isArray(record.items)) return record.items;
  if (Array.isArray(record.knowledge)) return record.knowledge;
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
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return null;
  if (/^\s*(none|no candidates?|候補なし|なし)\s*$/i.test(normalized)) return null;
  if (
    /"candidates"\s*:/.test(normalized) &&
    !/^\s*(type|title|body|score)\s*[:：]/im.test(normalized)
  ) {
    return null;
  }

  const fenceMatch = normalized.match(/```(?:text|md|markdown)?\s*([\s\S]*?)```/i);
  const body = (fenceMatch?.[1] ?? normalized).trim();
  if (!body) return null;

  const lines = body.split("\n");
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
      /^(type|title|body|score|confidence|importance|rationale|sourceRefs|evidenceRefs)\s*[:：]\s*(.*)$/i,
    );
    if (labelMatch) {
      const key = labelMatch[1]?.toLowerCase();
      const value = labelMatch[2]?.trim() ?? "";
      if (!key) continue;
      if (key === "body" || key === "rationale") {
        record[key] = value;
        currentMultilineField = key;
      } else if (key === "score" || key === "confidence" || key === "importance") {
        record[key] = Number(value);
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
    candidates: [...byKey.values()].sort((left, right) => right.score - left.score),
    jsonRepaired: rawCandidates.jsonRepaired,
    parseStrategies: rawCandidates.parseStrategies,
  };
}

export function parseDistillationCandidates(text: string): DistilledKnowledgeCandidate[] {
  return parseDistillationCandidateList(text).slice(
    0,
    groupedConfig.distillationTools.maxCandidates,
  );
}

function hasUrl(value: unknown): boolean {
  if (typeof value === "string") return /https?:\/\//i.test(value);
  if (Array.isArray(value)) return value.some((item) => hasUrl(item));
  if (value && typeof value === "object") return Object.values(value).some((item) => hasUrl(item));
  return false;
}

function hasSuccessfulFetch(toolEvents: DistillationToolResult[] = []): boolean {
  return toolEvents.some((event) => event.name === "fetch_content" && event.ok);
}

function normalizedTextLength(value: string): number {
  return value.replace(/\s+/g, "").length;
}

function isToolNameOnly(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "search_web" || normalized === "fetch_content" || normalized === "fetch_";
}

function isMeaningfulKnowledgeCandidate(candidate: DistilledKnowledgeCandidate): boolean {
  const titleLength = normalizedTextLength(candidate.title);
  const bodyLength = normalizedTextLength(candidate.body);
  if (titleLength < 3 || bodyLength < 12) return false;
  if (candidate.title.trim().toLowerCase() === candidate.body.trim().toLowerCase()) return false;
  if (isToolNameOnly(candidate.title) || isToolNameOnly(candidate.body)) return false;
  return true;
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

export function filterDistillationCandidatesByScore(
  candidates: DistilledKnowledgeCandidate[],
  options: DistillationScoreGateOptions = {},
): DistillationScoreGateResult {
  const threshold = groupedConfig.distillationTools.minCandidateScore;
  const rejectedInvalidEvidence = candidates.filter(
    (candidate) =>
      !hasValidExternalEvidence(
        candidate,
        options.toolEvents,
        options.requireFetchEvidenceForUrlInput,
      ),
  );
  const invalidKeys = new Set(rejectedInvalidEvidence.map(candidateKey));
  const accepted = candidates
    .filter(
      (candidate) =>
        candidate.score >= threshold &&
        isMeaningfulKnowledgeCandidate(candidate) &&
        !invalidKeys.has(candidateKey(candidate)),
    )
    .slice(0, groupedConfig.distillationTools.maxCandidates);
  const rejectedLowScore = candidates.filter(
    (candidate) =>
      (candidate.score < threshold || !isMeaningfulKnowledgeCandidate(candidate)) &&
      !invalidKeys.has(candidateKey(candidate)),
  );
  return { accepted, rejectedLowScore, rejectedInvalidEvidence, threshold };
}

export function summarizeRejectedCandidates(
  candidates: DistilledKnowledgeCandidate[],
): Array<{ type: string; title: string; score: number; rationale?: string }> {
  return candidates.slice(0, 5).map((candidate) => ({
    type: candidate.type,
    title: candidate.title,
    score: candidate.score,
    rationale: candidate.rationale,
  }));
}
