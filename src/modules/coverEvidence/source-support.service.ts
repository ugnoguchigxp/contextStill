import { groupedConfig } from "../../config.js";
import { readVibeMemoryByTokenWindow } from "../memoryReader/reader.service.js";
import { readFileDomain } from "../readFile/domain.js";
import type { CoverEvidenceReference } from "./types.js";
import type { CoverEvidenceCandidateInput } from "./types.js";

export type CoverEvidenceSourceRead = {
  content: string;
  valueAssessmentContent: string;
  references: CoverEvidenceReference[];
  readRanges: Array<{ from: number; toExclusive: number }>;
};

export type SourceSupportResult =
  | {
      ok: true;
      confidence: number;
      overlapRatio: number;
      matchedTokenCount: number;
      checkedTokenCount: number;
    }
  | {
      ok: false;
      reason: "unsupported_by_source" | "not_actionable" | "too_context_dependent";
      confidence: number;
      overlapRatio: number;
      matchedTokenCount: number;
      checkedTokenCount: number;
    };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeReadRange(value: unknown): { from: number; toExclusive: number } | null {
  const record = asRecord(value);
  const from = Number(record.from);
  const toExclusive = Number(record.toExclusive);
  if (!Number.isInteger(from) || from < 0) return null;
  if (!Number.isInteger(toExclusive) || toExclusive <= from) return null;
  return { from, toExclusive };
}

function isReadRange(
  value: { from: number; toExclusive: number } | null,
): value is { from: number; toExclusive: number } {
  return value !== null;
}

function readRangesFromOrigin(origin: unknown): Array<{ from: number; toExclusive: number }> {
  const originRecord = asRecord(origin);
  const ranges = Array.isArray(originRecord.readRanges)
    ? originRecord.readRanges.map(normalizeReadRange).filter(isReadRange)
    : [];
  if (ranges.length > 0) return ranges;
  return [{ from: 0, toExclusive: groupedConfig.readFile.defaultTokens }];
}

const MAX_ORIGIN_SOURCE_SUMMARY_CHARS = 1000;

function sourceSummaryFromOrigin(origin: unknown): string | undefined {
  const record = asRecord(origin);
  const value =
    record.sourceSummary ??
    record.source_summary ??
    record.sourceEvidenceSummary ??
    record.evidenceSummary;
  if (typeof value !== "string") return undefined;
  const summary = value.replace(/\s+/g, " ").trim();
  return summary ? summary.slice(0, MAX_ORIGIN_SOURCE_SUMMARY_CHARS) : undefined;
}

export async function readSourceEvidenceForCandidate(
  row: CoverEvidenceCandidateInput,
): Promise<CoverEvidenceSourceRead> {
  const valueAssessmentContent = sourceSummaryFromOrigin(row.origin);
  if (row.targetKind === "knowledge_candidate") {
    return {
      content: row.content,
      valueAssessmentContent: valueAssessmentContent ?? row.content,
      references: [
        {
          kind: "source",
          uri: row.sourceUri,
          locator: "candidate:content",
          note: "registered candidate content",
          evidenceRole: "supports_candidate",
        },
      ],
      readRanges: [{ from: 0, toExclusive: row.content.length }],
    };
  }

  const ranges = readRangesFromOrigin(row.origin).slice(0, 8);
  const contentParts: string[] = [];
  const references: CoverEvidenceReference[] = [];
  const readRanges: Array<{ from: number; toExclusive: number }> = [];

  for (const range of ranges) {
    const readTokens = Math.max(1, range.toExclusive - range.from);
    const read =
      row.targetKind === "wiki_file" || row.targetKind === "web_ingest"
        ? await readFileDomain({
            path: row.targetKind === "web_ingest" ? row.sourceUri : row.targetKey,
            fromToken: range.from,
            readTokens,
            minify: true,
          })
        : await readVibeMemoryByTokenWindow({
            vibeMemoryId: row.targetKey,
            fromToken: range.from,
            readTokens,
            mode: "compressed",
          });
    contentParts.push(read.content);
    readRanges.push({ from: read.from, toExclusive: read.toExclusive });
    references.push({
      kind: "source",
      uri: row.sourceUri,
      locator: `tokens:${read.from}-${read.toExclusive}`,
      note: "candidate origin read range",
      evidenceRole: "supports_candidate",
    });
  }

  const content = contentParts.join("\n\n---\n\n").trim();
  return {
    content,
    valueAssessmentContent: valueAssessmentContent ?? content,
    references,
    readRanges,
  };
}

const stopWords = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "should",
  "must",
  "する",
  "した",
  "して",
  "ます",
  "です",
  "こと",
  "ため",
  "よう",
]);

function knowledgeTokens(value: string): string[] {
  const normalized = value.normalize("NFKC").toLowerCase();
  const rawTokens =
    normalized.match(
      /[a-z0-9][a-z0-9._:/@+-]{2,}|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]{2,}/giu,
    ) ?? [];
  const tokens: string[] = [];
  for (const rawToken of rawTokens) {
    const token = rawToken.trim();
    if (!token || stopWords.has(token)) continue;
    tokens.push(token);
    if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]+$/u.test(token)) {
      for (let index = 0; index <= token.length - 4; index += 2) {
        tokens.push(token.slice(index, index + 4));
      }
    }
  }
  return [...new Set(tokens)];
}

function normalizedLength(value: string): number {
  return [...value].filter((char) => char.trim()).length;
}

export function evaluateSourceSupport(params: {
  title: string;
  body: string;
  sourceContent: string;
}): SourceSupportResult {
  if (normalizedLength(params.title) < 3 || normalizedLength(params.body) < 24) {
    return {
      ok: false,
      reason: "not_actionable",
      confidence: 35,
      overlapRatio: 0,
      matchedTokenCount: 0,
      checkedTokenCount: 0,
    };
  }

  const source = params.sourceContent.normalize("NFKC").toLowerCase();
  if (!source.trim()) {
    return {
      ok: false,
      reason: "unsupported_by_source",
      confidence: 30,
      overlapRatio: 0,
      matchedTokenCount: 0,
      checkedTokenCount: 0,
    };
  }

  const exactBodySupported = source.includes(params.body.normalize("NFKC").toLowerCase().trim());
  const bodyTokens = knowledgeTokens(params.body);
  const titleTokens = knowledgeTokens(params.title);
  const candidateTokens = (
    bodyTokens.length >= 3 ? bodyTokens : [...bodyTokens, ...titleTokens]
  ).slice(0, 32);
  const matchedTokenCount = candidateTokens.filter((token) => source.includes(token)).length;
  const checkedTokenCount = candidateTokens.length;
  const overlapRatio =
    checkedTokenCount > 0 ? matchedTokenCount / Math.max(1, checkedTokenCount) : 0;
  const ok =
    exactBodySupported ||
    matchedTokenCount >= Math.min(4, Math.max(2, Math.ceil(checkedTokenCount * 0.25))) ||
    overlapRatio >= 0.35;

  if (!ok) {
    return {
      ok: false,
      reason: "unsupported_by_source",
      confidence: Math.round(35 + overlapRatio * 30),
      overlapRatio,
      matchedTokenCount,
      checkedTokenCount,
    };
  }

  return {
    ok: true,
    confidence: Math.round(Math.min(92, 62 + overlapRatio * 25 + (exactBodySupported ? 8 : 0))),
    overlapRatio,
    matchedTokenCount,
    checkedTokenCount,
  };
}
