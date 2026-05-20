import { calculateBigramSimilarity, findSimilarKnowledge } from "../../lib/knowledge-dedup.js";
import { searchKnowledge, type KnowledgeSearchResult } from "../knowledge/knowledge.repository.js";
import type { CoverEvidenceCandidate, CoverEvidenceDuplicateRef } from "./types.js";

export type CoverEvidenceDedupeResult =
  | { status: "unique"; duplicateRefs: CoverEvidenceDuplicateRef[] }
  | { status: "duplicate" | "near_duplicate"; duplicateRefs: CoverEvidenceDuplicateRef[] };

function exactText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function duplicateRef(params: {
  id: string;
  title: string;
  score: number;
  reason: string;
}): CoverEvidenceDuplicateRef {
  return {
    knowledgeId: params.id,
    title: params.title,
    score: Number(params.score.toFixed(3)),
    reason: params.reason,
  };
}

function refsFromSearchResults(
  candidate: CoverEvidenceCandidate,
  rows: Array<Pick<KnowledgeSearchResult, "id" | "title" | "body" | "score">>,
): CoverEvidenceDuplicateRef[] {
  return rows
    .map((row) => {
      const bodySimilarity = calculateBigramSimilarity(candidate.body, row.body);
      const titleSimilarity = calculateBigramSimilarity(candidate.title, row.title);
      const score = Math.max(bodySimilarity, titleSimilarity * 0.6 + bodySimilarity * 0.4);
      return duplicateRef({
        id: row.id,
        title: row.title,
        score,
        reason: `title:${titleSimilarity.toFixed(3)} body:${bodySimilarity.toFixed(3)}`,
      });
    })
    .filter((ref) => (ref.score ?? 0) >= 0.62)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

export async function dedupeCoverEvidenceCandidate(
  candidate: CoverEvidenceCandidate,
): Promise<CoverEvidenceDedupeResult> {
  const lexicalHits = await searchKnowledge({
    query: `${candidate.title} ${candidate.body}`.slice(0, 512),
    limit: 8,
    status: "active",
    statuses: ["active", "draft"],
    includeDraft: true,
  }).catch(() => []);

  const semanticHits = await findSimilarKnowledge(candidate.title, candidate.body, {
    topK: 8,
    minSimilarity: 0.62,
  }).catch(() => []);

  const byId = new Map<string, { id: string; title: string; body: string; score: number }>();
  for (const row of lexicalHits) {
    byId.set(row.id, { id: row.id, title: row.title, body: row.body, score: row.score });
  }
  for (const row of semanticHits) {
    byId.set(row.id, { id: row.id, title: row.title, body: row.body, score: row.similarity });
  }

  const hits = [...byId.values()];
  const duplicateRefs = refsFromSearchResults(candidate, hits).slice(0, 5);
  if (duplicateRefs.length === 0) return { status: "unique", duplicateRefs: [] };

  const exactTitle = exactText(candidate.title);
  const exactBody = exactText(candidate.body);
  const exactMatch = hits.some(
    (hit) => exactText(hit.title) === exactTitle && exactText(hit.body) === exactBody,
  );
  const topScore = duplicateRefs[0]?.score ?? 0;

  if (exactMatch || topScore >= 0.92) {
    return { status: "duplicate", duplicateRefs };
  }
  if (topScore >= 0.82) {
    return { status: "near_duplicate", duplicateRefs };
  }
  return { status: "unique", duplicateRefs };
}
