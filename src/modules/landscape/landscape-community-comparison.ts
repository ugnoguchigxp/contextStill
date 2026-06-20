import { sql } from "drizzle-orm";
import { resolveDatabaseBackendConfig } from "../../db/backend.js";
import { db } from "../../db/index.js";
import { knowledgeItems } from "../../db/schema.js";
import { buildCommunityAssignments } from "../graph/community-builder.js";
import type {
  LandscapeCommunityComparison,
  LandscapeCommunityComparisonKind,
  LandscapeCommunityComparisonSummary,
} from "./landscape-replay.types.js";
import type { LandscapeClassificationPrimary } from "./landscape.types.js";

export type LandscapeRelationCommunityAssignment = {
  knowledgeId: string;
  communityKey: string;
  communityLabel: string;
  communityRank: number;
  communitySize: number;
  classificationAtAnalysis: LandscapeClassificationPrimary;
};

type SemanticAssignment = {
  knowledgeId: string;
  communityKey: string;
  communitySize: number;
};

type SemanticEdge = {
  source: string;
  target: string;
  weight: number;
};

const SEMANTIC_REACHABLE_DEAD_ZONE_MIN_JACCARD = 0.12;

function isSqliteBackend(): boolean {
  return resolveDatabaseBackendConfig().kind === "sqlite";
}

function knowledgeNodeId(id: string): string {
  return `knowledge:${id}`;
}

function rawKnowledgeId(nodeId: string): string {
  return nodeId.replace(/^knowledge:/, "");
}

function finiteOrFallback(value: unknown, fallback: number): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function countByComparison(
  communities: LandscapeCommunityComparison[],
  comparison: LandscapeCommunityComparisonKind,
): number {
  return communities.filter((community) => community.comparison === comparison).length;
}

function isDeadZone(classification: LandscapeClassificationPrimary): boolean {
  return classification === "dead_zone_reachability_risk" || classification === "dead_zone_stale";
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) return 1;
  let intersection = 0;
  for (const item of left) {
    if (right.has(item)) intersection += 1;
  }
  const union = new Set([...left, ...right]).size;
  return union > 0 ? intersection / union : 0;
}

async function loadSemanticNodes(knowledgeIds: string[]): Promise<Array<{ id: string }>> {
  if (knowledgeIds.length === 0) return [];
  const rows = await db
    .select({
      id: knowledgeItems.id,
    })
    .from(knowledgeItems)
    .where(andInKnowledgeIdsWithEmbedding(knowledgeIds));
  return rows.map((row) => ({ id: row.id }));
}

function andInKnowledgeIdsWithEmbedding(knowledgeIds: string[]) {
  return sql`${knowledgeItems.id} in (${sql.join(
    knowledgeIds.map((id) => sql`${id}`),
    sql`, `,
  )}) and ${knowledgeItems.embedding} is not null`;
}

async function loadSemanticEdges(params: {
  knowledgeIds: string[];
  minSimilarity: number;
  semanticTopK: number;
}): Promise<SemanticEdge[]> {
  if (params.knowledgeIds.length < 2) return [];
  const idsSql = sql.join(
    params.knowledgeIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const fetchLimit = Math.max(params.knowledgeIds.length * params.semanticTopK * 3, 100);
  const result = await db.execute(sql`
    select
      a.id::text as source_id,
      b.id::text as target_id,
      (1 - (a.embedding <=> b.embedding))::real as similarity
    from ${knowledgeItems} a
    join ${knowledgeItems} b on a.id < b.id
    where a.id in (${idsSql})
      and b.id in (${idsSql})
      and a.embedding is not null
      and b.embedding is not null
      and (1 - (a.embedding <=> b.embedding)) >= ${params.minSimilarity}
    order by similarity desc
    limit ${fetchLimit}
  `);

  const rows = result.rows as Array<{
    source_id: string;
    target_id: string;
    similarity: number | string;
  }>;
  const degreeByKnowledgeId = new Map<string, number>();
  const edges: SemanticEdge[] = [];

  for (const row of rows) {
    const sourceDegree = degreeByKnowledgeId.get(row.source_id) ?? 0;
    const targetDegree = degreeByKnowledgeId.get(row.target_id) ?? 0;
    if (sourceDegree >= params.semanticTopK || targetDegree >= params.semanticTopK) continue;

    edges.push({
      source: knowledgeNodeId(row.source_id),
      target: knowledgeNodeId(row.target_id),
      weight: Math.max(0.1, finiteOrFallback(row.similarity, 0)),
    });
    degreeByKnowledgeId.set(row.source_id, sourceDegree + 1);
    degreeByKnowledgeId.set(row.target_id, targetDegree + 1);
  }

  return edges;
}

export async function buildSemanticCommunityAssignments(params: {
  knowledgeIds: string[];
  minSimilarity: number;
  semanticTopK: number;
}): Promise<Map<string, SemanticAssignment>> {
  if (isSqliteBackend()) return new Map();

  const knowledgeIds = [...new Set(params.knowledgeIds.filter((id) => id.trim().length > 0))];
  const nodes = await loadSemanticNodes(knowledgeIds);
  if (nodes.length === 0) return new Map();
  const edges = await loadSemanticEdges({
    knowledgeIds: nodes.map((node) => node.id),
    minSimilarity: params.minSimilarity,
    semanticTopK: params.semanticTopK,
  });
  const communities = buildCommunityAssignments({
    nodes: nodes.map((node) => ({ id: knowledgeNodeId(node.id), weight: 1 })),
    edges,
    minEdgeWeight: params.minSimilarity,
  });

  const result = new Map<string, SemanticAssignment>();
  for (const [nodeId, assignment] of communities.assignments) {
    result.set(rawKnowledgeId(nodeId), {
      knowledgeId: rawKnowledgeId(nodeId),
      communityKey: assignment.communityKey,
      communitySize: assignment.communitySize,
    });
  }
  return result;
}

export function classifyLandscapeCommunityComparison(params: {
  relationClassification: LandscapeClassificationPrimary;
  semanticKeyCount: number;
  bestJaccardOverlap: number;
  bestSemanticCommunitySize: number;
  selectedNeighborCountWindow: number;
}): LandscapeCommunityComparisonKind {
  if (
    isDeadZone(params.relationClassification) &&
    params.selectedNeighborCountWindow > 0 &&
    params.bestJaccardOverlap >= SEMANTIC_REACHABLE_DEAD_ZONE_MIN_JACCARD
  ) {
    return "semantic_reachable_dead_zone";
  }
  if (params.semanticKeyCount === 0) return "relation_orphan";
  if (params.semanticKeyCount > 1) return "semantic_split";
  if (params.bestSemanticCommunitySize > 0 && params.bestJaccardOverlap < 0.8) {
    return "semantic_merge";
  }
  return "aligned";
}

export async function buildLandscapeCommunityComparison(params: {
  knowledgeIds: string[];
  relationAssignmentsByKnowledgeId: Map<string, LandscapeRelationCommunityAssignment>;
  selectedItemCountByKnowledgeId: Map<string, number>;
  minSimilarity: number;
  semanticTopK: number;
}): Promise<LandscapeCommunityComparisonSummary> {
  if (isSqliteBackend()) {
    const universeKnowledgeIds = [...new Set(params.knowledgeIds.filter(Boolean))];
    return {
      universeKnowledgeCount: universeKnowledgeIds.length,
      comparedKnowledgeCount: 0,
      missingRelationAssignmentCount: universeKnowledgeIds.filter(
        (knowledgeId) => !params.relationAssignmentsByKnowledgeId.has(knowledgeId),
      ).length,
      missingSemanticAssignmentCount: universeKnowledgeIds.length,
      alignedCount: 0,
      semanticSplitCount: 0,
      semanticMergeCount: 0,
      relationOrphanCount: 0,
      semanticReachableDeadZoneCount: 0,
      communities: [],
    };
  }

  const universeKnowledgeIds = [...new Set(params.knowledgeIds.filter(Boolean))];
  const semanticAssignmentsByKnowledgeId = await buildSemanticCommunityAssignments({
    knowledgeIds: universeKnowledgeIds,
    minSimilarity: params.minSimilarity,
    semanticTopK: params.semanticTopK,
  });

  const relationMembersByKey = new Map<string, LandscapeRelationCommunityAssignment[]>();
  for (const assignment of params.relationAssignmentsByKnowledgeId.values()) {
    const members = relationMembersByKey.get(assignment.communityKey) ?? [];
    members.push(assignment);
    relationMembersByKey.set(assignment.communityKey, members);
  }

  const semanticMembersByKey = new Map<string, Set<string>>();
  const relationKeysBySemanticKey = new Map<string, Set<string>>();
  for (const [knowledgeId, semantic] of semanticAssignmentsByKnowledgeId) {
    const semanticMembers = semanticMembersByKey.get(semantic.communityKey) ?? new Set<string>();
    semanticMembers.add(knowledgeId);
    semanticMembersByKey.set(semantic.communityKey, semanticMembers);

    const relation = params.relationAssignmentsByKnowledgeId.get(knowledgeId);
    if (relation) {
      const relationKeys =
        relationKeysBySemanticKey.get(semantic.communityKey) ?? new Set<string>();
      relationKeys.add(relation.communityKey);
      relationKeysBySemanticKey.set(semantic.communityKey, relationKeys);
    }
  }

  const communities: LandscapeCommunityComparison[] = [];
  for (const [relationCommunityKey, members] of relationMembersByKey) {
    const first = members[0];
    if (!first) continue;
    const relationMemberIds = new Set(members.map((member) => member.knowledgeId));
    const semanticKeys = new Set<string>();
    for (const member of members) {
      const semanticKey = semanticAssignmentsByKnowledgeId.get(member.knowledgeId)?.communityKey;
      if (semanticKey) semanticKeys.add(semanticKey);
    }

    let bestSemanticCommunityKey: string | undefined;
    let bestJaccardOverlap = 0;
    let bestSemanticMembers = new Set<string>();
    for (const semanticKey of semanticKeys) {
      const semanticMembers = semanticMembersByKey.get(semanticKey) ?? new Set<string>();
      const overlap = jaccard(relationMemberIds, semanticMembers);
      if (
        overlap > bestJaccardOverlap ||
        (overlap === bestJaccardOverlap &&
          semanticKey.localeCompare(bestSemanticCommunityKey ?? "") < 0)
      ) {
        bestSemanticCommunityKey = semanticKey;
        bestJaccardOverlap = overlap;
        bestSemanticMembers = semanticMembers;
      }
    }

    const selectedNeighborKnowledgeIds = [...bestSemanticMembers]
      .filter((knowledgeId) => !relationMemberIds.has(knowledgeId))
      .filter((knowledgeId) => (params.selectedItemCountByKnowledgeId.get(knowledgeId) ?? 0) > 0)
      .sort();
    const selectedNeighborCountWindow = selectedNeighborKnowledgeIds.reduce(
      (sum, knowledgeId) => sum + (params.selectedItemCountByKnowledgeId.get(knowledgeId) ?? 0),
      0,
    );
    const comparison = classifyLandscapeCommunityComparison({
      relationClassification: first.classificationAtAnalysis,
      semanticKeyCount: semanticKeys.size,
      bestJaccardOverlap,
      bestSemanticCommunitySize: bestSemanticMembers.size,
      selectedNeighborCountWindow,
    });

    communities.push({
      relationCommunityKey,
      relationCommunityLabel: first.communityLabel,
      relationCommunityRank: first.communityRank,
      ...(bestSemanticCommunityKey ? { semanticCommunityKey: bestSemanticCommunityKey } : {}),
      comparison,
      jaccardOverlap: clamp01(bestJaccardOverlap),
      relationCommunitySize: relationMemberIds.size,
      semanticCommunitySize: bestSemanticMembers.size,
      selectedNeighborCountWindow,
      selectedNeighborKnowledgeIds,
      deadZoneSemanticReachabilityScore: isDeadZone(first.classificationAtAnalysis)
        ? clamp01(selectedNeighborCountWindow / Math.max(1, relationMemberIds.size))
        : 0,
    });
  }

  communities.sort(
    (a, b) =>
      b.deadZoneSemanticReachabilityScore - a.deadZoneSemanticReachabilityScore ||
      a.relationCommunityRank - b.relationCommunityRank ||
      a.relationCommunityKey.localeCompare(b.relationCommunityKey),
  );

  let missingRelationAssignmentCount = 0;
  let missingSemanticAssignmentCount = 0;
  let comparedKnowledgeCount = 0;
  for (const knowledgeId of universeKnowledgeIds) {
    const hasRelation = params.relationAssignmentsByKnowledgeId.has(knowledgeId);
    const hasSemantic = semanticAssignmentsByKnowledgeId.has(knowledgeId);
    if (!hasRelation) missingRelationAssignmentCount += 1;
    if (!hasSemantic) missingSemanticAssignmentCount += 1;
    if (hasRelation && hasSemantic) comparedKnowledgeCount += 1;
  }

  return {
    universeKnowledgeCount: universeKnowledgeIds.length,
    comparedKnowledgeCount,
    missingRelationAssignmentCount,
    missingSemanticAssignmentCount,
    alignedCount: countByComparison(communities, "aligned"),
    semanticSplitCount: countByComparison(communities, "semantic_split"),
    semanticMergeCount: countByComparison(communities, "semantic_merge"),
    relationOrphanCount: countByComparison(communities, "relation_orphan"),
    semanticReachableDeadZoneCount: countByComparison(communities, "semantic_reachable_dead_zone"),
    communities,
  };
}
