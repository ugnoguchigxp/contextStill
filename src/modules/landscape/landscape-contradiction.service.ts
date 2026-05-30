import { createHash } from "node:crypto";
import { buildGraphSnapshot } from "../../../api/modules/graph/graph.repository.js";
import {
  type LandscapeContradictionCandidate,
  type LandscapeContradictionDetectionInput,
  landscapeContradictionCandidateSchema,
  landscapeContradictionDetectionInputSchema,
} from "../../shared/schemas/landscape-contradiction.schema.js";
import {
  type LandscapeContradictionKnowledgeRow,
  contradictionPairKey,
  loadContradictionKnowledgeRows,
  loadRecentSelectionCountByKnowledgeId,
  loadSemanticNeighborPairs,
} from "./landscape-contradiction.repository.js";

const REQUIREMENT_MARKERS_LATIN = ["must", "required", "always"];
const REQUIREMENT_MARKERS_CJK = ["必須", "必ず"];
const REQUIREMENT_MARKERS = [...REQUIREMENT_MARKERS_LATIN, ...REQUIREMENT_MARKERS_CJK];
const AVOIDANCE_MARKERS_LATIN = ["avoid", "never", "do not", "don't"];
const AVOIDANCE_MARKERS_CJK = ["禁止", "避ける", "しない"];
const AVOIDANCE_MARKERS = [...AVOIDANCE_MARKERS_LATIN, ...AVOIDANCE_MARKERS_CJK];
const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "from",
  "into",
  "when",
  "where",
  "which",
  "while",
  "without",
  "should",
  "could",
  "would",
  "must",
  "always",
  "never",
  "avoid",
  "required",
  "rule",
  "procedure",
  "knowledge",
  "review",
  "context",
  "apply",
  "applies",
  "target",
  "about",
  "against",
  "ため",
  "こと",
  "これ",
  "それ",
  "ない",
  "する",
  "した",
  "して",
]);

type ScopeFacets = {
  repoPath: string | null;
  repoKey: string | null;
  technologies: string[];
  changeTypes: string[];
  domains: string[];
};

type MarkerResult = {
  require: string[];
  avoid: string[];
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const deduped = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const normalized = entry.trim().toLowerCase();
    if (!normalized) continue;
    deduped.add(normalized);
  }
  return [...deduped].sort((left, right) => left.localeCompare(right));
}

function normalizeScopeFacets(appliesTo: unknown): ScopeFacets {
  const record = asRecord(appliesTo);
  return {
    repoPath: normalizeString(record.repoPath),
    repoKey: normalizeString(record.repoKey),
    technologies: normalizeStringArray(record.technologies),
    changeTypes: normalizeStringArray(record.changeTypes),
    domains: normalizeStringArray(record.domains),
  };
}

function intersect(left: string[], right: string[]): string[] {
  if (left.length === 0 || right.length === 0) return [];
  const rightSet = new Set(right);
  return left.filter((entry) => rightSet.has(entry));
}

function scopeOverlap(left: ScopeFacets, right: ScopeFacets) {
  const repoPath = Boolean(left.repoPath && right.repoPath && left.repoPath === right.repoPath);
  const repoKey = Boolean(left.repoKey && right.repoKey && left.repoKey === right.repoKey);
  return {
    repoPath,
    repoKey,
    technologies: intersect(left.technologies, right.technologies),
    changeTypes: intersect(left.changeTypes, right.changeTypes),
    domains: intersect(left.domains, right.domains),
  };
}

function hasScopeOverlap(overlap: ReturnType<typeof scopeOverlap>): boolean {
  return (
    overlap.repoPath ||
    overlap.repoKey ||
    overlap.technologies.length > 0 ||
    overlap.changeTypes.length > 0 ||
    overlap.domains.length > 0
  );
}

function buildMarkerResult(text: string): MarkerResult {
  const normalized = text.toLowerCase();
  const require = [
    ...REQUIREMENT_MARKERS_LATIN.filter((marker) => containsLatinMarker(normalized, marker)),
    ...REQUIREMENT_MARKERS_CJK.filter((marker) => text.includes(marker)),
  ];
  const avoid = [
    ...AVOIDANCE_MARKERS_LATIN.filter((marker) => containsLatinMarker(normalized, marker)),
    ...AVOIDANCE_MARKERS_CJK.filter((marker) => text.includes(marker)),
  ];
  return {
    require,
    avoid,
  };
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsLatinMarker(normalizedText: string, marker: string): boolean {
  const pattern = new RegExp(`(^|[^a-z0-9_])${escapeRegex(marker)}(?=$|[^a-z0-9_])`, "i");
  return pattern.test(normalizedText);
}

function extractConceptTokens(input: string): string[] {
  const normalized = input.toLowerCase();
  const matches = normalized.match(/[a-z0-9_\-/]{3,}|[一-龠ぁ-んァ-ヶー]{2,}/g) ?? [];
  const deduped = new Set<string>();
  for (const token of matches) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    if (STOPWORDS.has(trimmed)) continue;
    if (REQUIREMENT_MARKERS.includes(trimmed) || AVOIDANCE_MARKERS.includes(trimmed)) continue;
    deduped.add(trimmed);
    if (deduped.size >= 32) break;
  }
  return [...deduped];
}

function excerpt(text: string, markers: string[]): string {
  const flattened = text.replace(/\s+/g, " ").trim();
  if (!flattened) return "";
  const lower = flattened.toLowerCase();
  let anchor = -1;
  for (const marker of markers) {
    const index = lower.indexOf(marker.toLowerCase());
    if (index >= 0) {
      anchor = index;
      break;
    }
  }
  if (anchor < 0) return flattened.slice(0, 160);
  const start = Math.max(0, anchor - 50);
  const end = Math.min(flattened.length, anchor + 110);
  const snippet = flattened.slice(start, end);
  return `${start > 0 ? "..." : ""}${snippet}${end < flattened.length ? "..." : ""}`;
}

function toConfidenceLabel(value: number): "low" | "medium" | "high" {
  if (value >= 0.82) return "high";
  if (value >= 0.72) return "medium";
  return "low";
}

function buildPairHash(leftKnowledgeId: string, rightKnowledgeId: string): string {
  const key = contradictionPairKey(leftKnowledgeId, rightKnowledgeId);
  const digest = createHash("sha1").update(key).digest("hex");
  return `sha1:${digest}`;
}

function computeConfidence(params: {
  overlap: ReturnType<typeof scopeOverlap>;
  relationNeighbor: boolean;
  semanticNeighbor: boolean;
  hasPolarityConflict: boolean;
  sharedConceptCount: number;
  deprecatedReuseRisk: boolean;
}): {
  score: number;
  breakdown: {
    scopeOverlap: number;
    semanticOrRelationNeighbor: number;
    polarityConflict: number;
    sharedConcept: number;
    deprecatedReuse: number;
  };
} {
  const scopeOverlapScore = clamp(
    (params.overlap.repoPath ? 0.11 : 0) +
      (params.overlap.repoKey ? 0.12 : 0) +
      (params.overlap.technologies.length > 0 ? 0.06 : 0) +
      (params.overlap.changeTypes.length > 0 ? 0.05 : 0) +
      (params.overlap.domains.length > 0 ? 0.05 : 0),
    0,
    0.3,
  );
  const semanticOrRelationNeighbor =
    (params.relationNeighbor ? 0.16 : 0) + (params.semanticNeighbor ? 0.16 : 0);
  const polarityConflict = params.hasPolarityConflict ? 0.32 : 0.16;
  const sharedConcept = params.sharedConceptCount >= 3 ? 0.22 : 0.16;
  const deprecatedReuse = params.deprecatedReuseRisk ? 0.1 : 0;

  const score = clamp(
    scopeOverlapScore +
      Math.min(semanticOrRelationNeighbor, 0.3) +
      polarityConflict +
      sharedConcept +
      deprecatedReuse,
    0,
    0.99,
  );

  return {
    score,
    breakdown: {
      scopeOverlap: Number(scopeOverlapScore.toFixed(3)),
      semanticOrRelationNeighbor: Number(Math.min(semanticOrRelationNeighbor, 0.3).toFixed(3)),
      polarityConflict: Number(polarityConflict.toFixed(3)),
      sharedConcept: Number(sharedConcept.toFixed(3)),
      deprecatedReuse: Number(deprecatedReuse.toFixed(3)),
    },
  };
}

function pairPriority(params: {
  confidence: number;
  hasPolarityConflict: boolean;
  deprecatedReuseRisk: boolean;
}) {
  return clamp(
    Math.round(
      40 +
        params.confidence * 38 +
        (params.hasPolarityConflict ? 6 : 0) +
        (params.deprecatedReuseRisk ? 4 : 0),
    ),
    0,
    100,
  );
}

function mapCommunityMembership(
  knowledgeIds: string[],
  communitySnapshot: Awaited<ReturnType<typeof buildGraphSnapshot>>,
) {
  const idSet = new Set(knowledgeIds);
  const byKnowledgeId = new Map<string, { communityKey: string; communityLabel: string }>();
  for (const node of communitySnapshot.nodes) {
    if (node.kind !== "knowledge") continue;
    if (!node.communityKey) continue;
    const knowledgeId = node.id.replace(/^knowledge:/, "");
    if (!idSet.has(knowledgeId)) continue;
    byKnowledgeId.set(knowledgeId, {
      communityKey: node.communityKey,
      communityLabel: node.communityLabel ?? node.communityId ?? node.communityKey,
    });
  }
  return byKnowledgeId;
}

function textForKnowledge(row: LandscapeContradictionKnowledgeRow): string {
  return `${row.title}\n${row.body}`;
}

function normalizeEvidenceEntries(entries: string[]): string[] {
  const deduped = new Set<string>();
  for (const entry of entries) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    deduped.add(trimmed);
    if (deduped.size >= 8) break;
  }
  return [...deduped];
}

export async function buildLandscapeContradictionCandidates(
  input: LandscapeContradictionDetectionInput,
): Promise<LandscapeContradictionCandidate[]> {
  const parsed = landscapeContradictionDetectionInputSchema.parse(input);
  const knowledgeRows = await loadContradictionKnowledgeRows(parsed.knowledgeLimit);
  if (knowledgeRows.length < 2) return [];

  const knowledgeIds = knowledgeRows.map((row) => row.id);
  const [recentSelectionCountByKnowledgeId, semanticPairSimilarityByKey, communitySnapshot] =
    await Promise.all([
      loadRecentSelectionCountByKnowledgeId({
        knowledgeIds,
        windowDays: parsed.windowDays,
      }),
      loadSemanticNeighborPairs({
        knowledgeIds,
        minSimilarity: parsed.semanticMinSimilarity,
        maxPairs: Math.max(parsed.candidateLimit * 3, 240),
        topKPerKnowledge: 3,
      }),
      buildGraphSnapshot({
        limit: Math.max(parsed.knowledgeLimit * 8, 1200),
        status: parsed.landscapeStatus,
        view: "community",
        relationAxes: parsed.relationAxes,
        communityDisplay: "detail",
      }),
    ]);

  const communityByKnowledgeId = mapCommunityMembership(knowledgeIds, communitySnapshot);
  const candidates: LandscapeContradictionCandidate[] = [];

  for (let leftIndex = 0; leftIndex < knowledgeRows.length; leftIndex += 1) {
    const left = knowledgeRows[leftIndex];
    if (!left) continue;

    const leftScope = normalizeScopeFacets(left.appliesTo);
    const leftText = textForKnowledge(left);
    const leftMarkers = buildMarkerResult(leftText);
    const leftConceptTokens = extractConceptTokens(leftText);

    for (let rightIndex = leftIndex + 1; rightIndex < knowledgeRows.length; rightIndex += 1) {
      const right = knowledgeRows[rightIndex];
      if (!right) continue;

      const activeActive = left.status === "active" && right.status === "active";
      const activeDeprecated =
        (left.status === "active" && right.status === "deprecated") ||
        (left.status === "deprecated" && right.status === "active");
      if (!activeActive && !activeDeprecated) continue;

      const rightScope = normalizeScopeFacets(right.appliesTo);
      const overlap = scopeOverlap(leftScope, rightScope);
      if (!hasScopeOverlap(overlap)) continue;

      const leftCommunity = communityByKnowledgeId.get(left.id);
      const rightCommunity = communityByKnowledgeId.get(right.id);
      const relationNeighbor =
        Boolean(leftCommunity?.communityKey) &&
        leftCommunity?.communityKey === rightCommunity?.communityKey;

      const pairKey = contradictionPairKey(left.id, right.id);
      const semanticSimilarity = semanticPairSimilarityByKey.get(pairKey) ?? 0;
      const semanticNeighbor = semanticSimilarity >= parsed.semanticMinSimilarity;
      if (!relationNeighbor && !semanticNeighbor) continue;

      const rightText = textForKnowledge(right);
      const rightMarkers = buildMarkerResult(rightText);
      const hasPolarityConflict =
        (leftMarkers.require.length > 0 && rightMarkers.avoid.length > 0) ||
        (rightMarkers.require.length > 0 && leftMarkers.avoid.length > 0);

      const rightConceptTokens = extractConceptTokens(rightText);
      const sharedConceptTokens = intersect(leftConceptTokens, rightConceptTokens).slice(0, 6);
      if (sharedConceptTokens.length === 0) continue;

      const deprecatedId =
        left.status === "deprecated" ? left.id : right.status === "deprecated" ? right.id : null;
      const deprecatedRecentSelection = deprecatedId
        ? (recentSelectionCountByKnowledgeId.get(deprecatedId) ?? 0)
        : 0;
      const deprecatedReuseRisk =
        deprecatedId !== null && deprecatedRecentSelection >= parsed.recentSelectionMin;

      if (!hasPolarityConflict && !deprecatedReuseRisk) continue;

      const confidence = computeConfidence({
        overlap,
        relationNeighbor,
        semanticNeighbor,
        hasPolarityConflict,
        sharedConceptCount: sharedConceptTokens.length,
        deprecatedReuseRisk,
      });
      if (confidence.score < parsed.confidenceThreshold) continue;

      const leftSnippet = excerpt(leftText, [...leftMarkers.require, ...leftMarkers.avoid]);
      const rightSnippet = excerpt(rightText, [...rightMarkers.require, ...rightMarkers.avoid]);
      const pairHash = buildPairHash(left.id, right.id);
      const confidenceLabel = toConfidenceLabel(confidence.score);
      const priority = pairPriority({
        confidence: confidence.score,
        hasPolarityConflict,
        deprecatedReuseRisk,
      });

      const payload = {
        generatedBy: "landscape_contradiction_detection",
        pairKey: pairHash,
        leftKnowledgeId: left.id,
        rightKnowledgeId: right.id,
        leftMarkers: [...leftMarkers.require, ...leftMarkers.avoid],
        rightMarkers: [...rightMarkers.require, ...rightMarkers.avoid],
        snippets: {
          left: leftSnippet,
          right: rightSnippet,
        },
        overlap: {
          repoPath: overlap.repoPath,
          repoKey: overlap.repoKey,
          technologies: overlap.technologies,
          changeTypes: overlap.changeTypes,
          domains: overlap.domains,
        },
        confidenceBreakdown: confidence.breakdown,
        semanticSimilarity: semanticSimilarity > 0 ? Number(semanticSimilarity.toFixed(4)) : null,
        relationCommunityKey: relationNeighbor ? (leftCommunity?.communityKey ?? null) : null,
        relationCommunityLabel: relationNeighbor ? (leftCommunity?.communityLabel ?? null) : null,
        deprecatedRecentSelection,
      };

      const evidence = normalizeEvidenceEntries([
        `pair=${left.id}::${right.id}`,
        `polarity=${hasPolarityConflict ? "conflict" : "deprecated_reuse"}`,
        `shared_concepts=${sharedConceptTokens.join(",")}`,
        `scope=repoPath:${String(overlap.repoPath)} repoKey:${String(overlap.repoKey)} technologies:${overlap.technologies.join("|")} changeTypes:${overlap.changeTypes.join("|")} domains:${overlap.domains.join("|")}`,
        `neighbor=relation:${String(relationNeighbor)} semantic:${String(semanticNeighbor)}`,
        leftSnippet ? `left:${leftSnippet}` : "",
        rightSnippet ? `right:${rightSnippet}` : "",
      ]);

      candidates.push(
        landscapeContradictionCandidateSchema.parse({
          pairKey: pairHash,
          leftKnowledgeId: left.id,
          rightKnowledgeId: right.id,
          confidence: Number(confidence.score.toFixed(4)),
          confidenceLabel,
          priority,
          relationNeighbor,
          semanticNeighbor,
          scopeOverlap: overlap,
          sharedConceptTokens,
          leftMarkers: [...leftMarkers.require, ...leftMarkers.avoid],
          rightMarkers: [...rightMarkers.require, ...rightMarkers.avoid],
          leftSnippet,
          rightSnippet,
          communityKey: relationNeighbor ? (leftCommunity?.communityKey ?? null) : null,
          communityLabel: relationNeighbor ? (leftCommunity?.communityLabel ?? null) : null,
          evidence,
          payload,
        }),
      );
    }
  }

  return [...candidates]
    .sort(
      (left, right) =>
        right.priority - left.priority ||
        right.confidence - left.confidence ||
        left.pairKey.localeCompare(right.pairKey),
    )
    .slice(0, parsed.candidateLimit);
}
