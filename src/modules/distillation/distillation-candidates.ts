import { z } from "zod";
import { config } from "../../config.js";
import { normalizeKnowledgeScore } from "../../lib/score-scale.js";
import type { KnowledgeItem } from "../../shared/schemas/knowledge.schema.js";
import type { DistillationToolResult } from "./distillation-tools.service.js";

const candidateSchema = z.object({
  type: z.enum(["rule", "procedure"]),
  title: z.string().trim().min(1),
  body: z.string().trim().min(1),
  confidence: z.coerce.number().optional(),
  importance: z.coerce.number().optional(),
  score: z.coerce.number(),
  rationale: z.string().trim().optional(),
  sourceRefs: z.array(z.union([z.string(), z.record(z.unknown())])).min(1),
  evidenceRefs: z.array(z.union([z.string(), z.record(z.unknown())])).optional(),
});

const distillationResponseSchema = z.object({
  candidates: z.array(z.unknown()).default([]),
});

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

function clamp01(value: unknown, fallback: number): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(1, Math.max(0, num));
}

function extractJsonPayload(text: string): unknown {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [
    fenceMatch?.[1],
    text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1),
  ].filter((candidate): candidate is string => Boolean(candidate?.trim()));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next representation.
    }
  }

  throw new Error("distillation response did not contain valid JSON");
}

function candidateKey(candidate: DistilledKnowledgeCandidate): string {
  return `${candidate.type}\0${candidate.title.toLowerCase()}\0${candidate.body.toLowerCase()}`;
}

export function parseDistillationCandidateList(text: string): DistilledKnowledgeCandidate[] {
  const payload = extractJsonPayload(text);
  const outerPayload = Array.isArray(payload) ? { candidates: payload } : payload;
  const parsed = distillationResponseSchema.parse(outerPayload);
  const byKey = new Map<string, DistilledKnowledgeCandidate>();

  for (const rawCandidate of parsed.candidates) {
    const candidate = candidateSchema.safeParse(rawCandidate);
    if (!candidate.success) continue;
    const confidence = normalizeKnowledgeScore(candidate.data.confidence, 65);
    const importance = normalizeKnowledgeScore(candidate.data.importance, 55);
    const normalized: DistilledKnowledgeCandidate = {
      type: candidate.data.type,
      title: candidate.data.title.trim(),
      body: candidate.data.body.trim(),
      confidence,
      importance,
      score: clamp01(candidate.data.score, 0),
      rationale: candidate.data.rationale?.trim() || undefined,
      sourceRefs: candidate.data.sourceRefs,
      evidenceRefs: candidate.data.evidenceRefs,
    };
    byKey.set(candidateKey(normalized), normalized);
  }

  return [...byKey.values()].sort((left, right) => right.score - left.score);
}

export function parseDistillationCandidates(text: string): DistilledKnowledgeCandidate[] {
  return parseDistillationCandidateList(text).slice(0, config.distillationMaxCandidates);
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

function hasEvidenceRefs(candidate: DistilledKnowledgeCandidate): boolean {
  return Array.isArray(candidate.evidenceRefs) && candidate.evidenceRefs.length > 0;
}

function hasValidExternalEvidence(
  candidate: DistilledKnowledgeCandidate,
  toolEvents?: DistillationToolResult[],
): boolean {
  const candidateMentionsUrl =
    hasUrl(candidate.title) ||
    hasUrl(candidate.body) ||
    hasUrl(candidate.rationale) ||
    hasUrl(candidate.sourceRefs) ||
    hasUrl(candidate.evidenceRefs);

  if (!candidateMentionsUrl && !hasEvidenceRefs(candidate)) return true;
  return hasEvidenceRefs(candidate) && hasSuccessfulFetch(toolEvents);
}

export function filterDistillationCandidatesByScore(
  candidates: DistilledKnowledgeCandidate[],
  options: { toolEvents?: DistillationToolResult[] } = {},
): DistillationScoreGateResult {
  const threshold = config.distillationMinCandidateScore;
  const rejectedInvalidEvidence = candidates.filter(
    (candidate) => !hasValidExternalEvidence(candidate, options.toolEvents),
  );
  const invalidKeys = new Set(rejectedInvalidEvidence.map(candidateKey));
  const accepted = candidates
    .filter(
      (candidate) => candidate.score >= threshold && !invalidKeys.has(candidateKey(candidate)),
    )
    .slice(0, config.distillationMaxCandidates);
  const rejectedLowScore = candidates.filter(
    (candidate) => candidate.score < threshold && !invalidKeys.has(candidateKey(candidate)),
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
