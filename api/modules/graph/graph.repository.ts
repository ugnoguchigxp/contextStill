import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../../src/db/index.js";
import {
  knowledgeCommunityLabels,
  knowledgeItems,
  knowledgeSourceLinks,
  sourceFragments,
  sources,
  vibeMemories,
} from "../../../src/db/schema.js";
import { normalizeKnowledgeScore, toUnitKnowledgeScore } from "../../../src/lib/score-scale.js";
import { normalizeRepoKey } from "../../../src/modules/context-compiler/query-context.js";
import {
  buildCommunityAssignments,
  type CommunityAssignment,
  type CommunityComponent,
} from "../../../src/modules/graph/community-builder.js";
import { computeDecayFactor } from "../../../src/modules/knowledge/knowledge-value.service.js";

/** グラフ表示専用の軽量ノード型（body 等の重いフィールドを除外） */
export type GraphNode = {
  id: string;
  label: string;
  kind: "knowledge" | "source";
  group: string;
  weight: number;
  status: string;
  embedded: boolean;
  communityId?: string;
  communityRank?: number;
  communitySize?: number;
  communityKey?: string;
  communityLabel?: string;
  sourceId?: string;
  sourceKind?: string;
  sourceUri?: string;
  sourceTitle?: string | null;
  linkedKnowledgeCount?: number;
};

/** ノードクリック時に取得する詳細型 */
export type GraphNodeDetail = {
  id: string;
  label: string;
  kind: "knowledge";
  group: string;
  detail: string;
  weight: number;
  status: string;
  confidence: number;
  importance: number;
  bodyPreview: string;
  embedded: boolean;
  communityId?: string;
  communityRank?: number;
  communitySize?: number;
};

export type GraphEdge = {
  id: string;
  source: string;
  target: string;
  relationType: string;
  edgeKind: "semantic" | "session" | "project" | "source" | "evidence";
  relationAxis: "semantic" | "session" | "project" | "source" | "evidence";
  derived: boolean;
  weight: number;
};

export type GraphCommunityHealth = {
  dead: boolean;
  stale: boolean;
  thinEvidence: boolean;
};

export type GraphCommunitySummary = {
  communityId: string;
  communityKey: string;
  communityLabel: string;
  communityRank: number;
  size: number;
  typeCounts: Record<string, number>;
  statusCounts: Record<string, number>;
  embeddedCount: number;
  compileSelectCount: number;
  staleNodeCount: number;
  sourceRefCount: number;
  sourceRefDensity: number;
  health: GraphCommunityHealth;
  note?: string;
  labelUpdatedAt?: string;
};

export type GraphSupernode = {
  id: string;
  label: string;
  communityKey: string;
  size: number;
  communityRank: number;
  health: GraphCommunityHealth;
};

export type GraphSuperedge = {
  id: string;
  source: string;
  target: string;
  weight: number;
};

type GraphStatusFilter = "current" | "active" | "draft" | "deprecated" | "all";

type GraphViewMode = "relation" | "semantic" | "community" | "evidence";
export type GraphRelationAxis = "session" | "project" | "source";
export type GraphCommunityDisplayMode = "detail" | "supernode";

export type GraphSnapshotParams = {
  limit: number;
  status?: GraphStatusFilter;
  view?: GraphViewMode;
  communityDisplay?: GraphCommunityDisplayMode;
  relationAxes?: GraphRelationAxis[];
  minSimilarity?: number;
  semanticTopK?: number;
  maxContextEdgesPerNode?: number;
  sourceNodeLimit?: number;
};

type RelationNodeContext = {
  id: string;
  importance: number;
  sessionKey?: string;
  projectKey?: string;
  sourceDocIds?: string[];
};

type CommunityLabelRecord = {
  communityKey: string;
  label: string;
  note: string | null;
  updatedAt: Date;
};

type EvidenceLinkRow = {
  knowledge_id: string;
  source_id: string;
  source_kind: string;
  source_uri: string;
  source_title: string | null;
  link_count: number | string;
};

const COMMUNITY_MIN_EDGE_WEIGHT = 0.7;
const COMMUNITY_STALE_DECAY_THRESHOLD = 0.82;
const COMMUNITY_STALE_RATIO_THRESHOLD = 0.5;
const COMMUNITY_THIN_EVIDENCE_DENSITY_THRESHOLD = 0.6;

function resolveStatusFilter(status: GraphStatusFilter | undefined): string[] | undefined {
  switch (status ?? "current") {
    case "current":
      return ["active", "draft"];
    case "active":
      return ["active"];
    case "draft":
      return ["draft"];
    case "deprecated":
      return ["deprecated"];
    case "all":
      return undefined;
  }
}

function preview(value: string, max = 220): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 3)}...`;
}

function finiteOrFallback(value: unknown, fallback: number): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function valueAsString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizedImportanceExpr() {
  return sql<number>`
    CASE
      WHEN ${knowledgeItems.importance} >= 0 AND ${knowledgeItems.importance} <= 1
        THEN ${knowledgeItems.importance} * 100
      ELSE ${knowledgeItems.importance}
    END
  `;
}

function normalizeGroupKey(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.toLowerCase();
}

function knowledgeNodeId(id: string): string {
  return `knowledge:${id}`;
}

function sourceNodeId(id: string): string {
  return `source:${id}`;
}

function unorderedPairKey(source: string, target: string): string {
  return [source, target].sort().join("::");
}

function normalizeKnowledgeType(type: string): "rule" | "procedure" {
  return type === "procedure" ? "procedure" : "rule";
}

function normalizeKnowledgeScope(scope: string): "repo" | "global" {
  return scope === "global" ? "global" : "repo";
}

function incrementCount(map: Record<string, number>, key: string) {
  map[key] = (map[key] ?? 0) + 1;
}

function pickProjectKey(
  appliesTo: Record<string, unknown>,
  metadata: Record<string, unknown>,
): string | undefined {
  const explicit =
    valueAsString(appliesTo.repoKey) ??
    valueAsString(metadata.repoKey) ??
    valueAsString(metadata.sourceProject);
  const normalizedExplicit = normalizeGroupKey(explicit);
  if (normalizedExplicit) return normalizedExplicit;

  const pathCandidate =
    valueAsString(appliesTo.repoPath) ??
    valueAsString(metadata.repoPath) ??
    valueAsString(metadata.sourceRepoPath) ??
    valueAsString(metadata.workspacePath) ??
    valueAsString(metadata.projectRoot);
  return normalizeRepoKey(pathCandidate) ?? normalizeGroupKey(pathCandidate);
}

function extractSessionKey(metadata: Record<string, unknown>): string | undefined {
  return valueAsString(metadata.sourceSessionId) ?? valueAsString(metadata.sessionId);
}

function sourceDocIdFromRef(value: unknown): string | undefined {
  const raw = valueAsString(value);
  if (!raw) return undefined;
  const [source] = raw.split("#", 1);
  const normalized = source?.trim();
  if (!normalized) return undefined;
  if (normalized.startsWith("cover-evidence-result://")) return undefined;
  if (normalized.startsWith("agent://")) return undefined;
  return normalized;
}

function sourceDocIdsFromMetadata(metadata: Record<string, unknown>): string[] {
  const refs = new Set<string>();
  for (const value of [
    metadata.sourceDocumentUri,
    metadata.sourceUri,
    ...(Array.isArray(metadata.sourceRefs) ? metadata.sourceRefs : []),
    ...(Array.isArray(metadata.candidateSourceRefs) ? metadata.candidateSourceRefs : []),
  ]) {
    const sourceDocId = sourceDocIdFromRef(value);
    if (sourceDocId) refs.add(sourceDocId);
  }

  const references = Array.isArray(metadata.references) ? metadata.references : [];
  for (const reference of references) {
    const record = asRecord(reference);
    const sourceDocId = sourceDocIdFromRef(record.uri);
    if (sourceDocId) refs.add(sourceDocId);
  }

  return [...refs];
}

function isDistilledKnowledgeMetadata(metadata: Record<string, unknown>): boolean {
  const coverEvidenceResultId = valueAsString(metadata.coverEvidenceResultId);
  return Boolean(coverEvidenceResultId);
}

async function buildSessionProjectLookup(sessionIds: string[]): Promise<Map<string, string>> {
  if (sessionIds.length === 0) return new Map();

  const rows = await db
    .select({
      sessionId: vibeMemories.sessionId,
      metadata: vibeMemories.metadata,
    })
    .from(vibeMemories)
    .where(inArray(vibeMemories.sessionId, sessionIds))
    .orderBy(desc(vibeMemories.createdAt));

  const projectBySession = new Map<string, string>();
  for (const row of rows) {
    if (projectBySession.has(row.sessionId)) continue;
    const metadata = asRecord(row.metadata);
    const projectRoot = valueAsString(metadata.projectRoot);
    const normalized = normalizeRepoKey(projectRoot) ?? normalizeGroupKey(projectRoot);
    if (!normalized) continue;
    projectBySession.set(row.sessionId, normalized);
  }
  return projectBySession;
}

function buildContextEdgesForGroup(params: {
  members: RelationNodeContext[];
  axis: "session" | "project" | "source";
  weight: number;
  maxEdgesPerNode: number;
}): GraphEdge[] {
  const members = params.members;
  if (members.length < 2) return [];

  const sorted = [...members].sort(
    (a, b) => b.importance - a.importance || a.id.localeCompare(b.id),
  );
  const hub = sorted[0];
  if (!hub) return [];

  const candidatePairs: Array<[RelationNodeContext, RelationNodeContext]> = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const node = sorted[i];
    if (node) candidatePairs.push([hub, node]);
  }
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const next = sorted[i];
    if (prev && next) candidatePairs.push([prev, next]);
  }

  const degree = new Map<string, number>();
  const seen = new Set<string>();
  const edges: GraphEdge[] = [];

  for (const [left, right] of candidatePairs) {
    if (!left || !right || left.id === right.id) continue;
    const sourceId = left.id < right.id ? left.id : right.id;
    const targetId = left.id < right.id ? right.id : left.id;
    const pairKey = unorderedPairKey(sourceId, targetId);
    if (seen.has(pairKey)) continue;
    const sourceDegree = degree.get(sourceId) ?? 0;
    const targetDegree = degree.get(targetId) ?? 0;
    if (sourceDegree >= params.maxEdgesPerNode || targetDegree >= params.maxEdgesPerNode) {
      continue;
    }
    seen.add(pairKey);
    degree.set(sourceId, sourceDegree + 1);
    degree.set(targetId, targetDegree + 1);

    edges.push({
      id: `${params.axis}:${sourceId}:${targetId}`,
      source: knowledgeNodeId(sourceId),
      target: knowledgeNodeId(targetId),
      relationType:
        params.axis === "session"
          ? "same_session"
          : params.axis === "project"
            ? "same_project"
            : "same_source",
      edgeKind: params.axis,
      relationAxis: params.axis,
      derived: true,
      weight: params.weight,
    });
  }

  return edges;
}

function enforceGlobalPerNodeCap(edges: GraphEdge[], maxEdgesPerNode: number): GraphEdge[] {
  const degree = new Map<string, number>();
  const result: GraphEdge[] = [];

  for (const edge of edges) {
    const sourceDegree = degree.get(edge.source) ?? 0;
    const targetDegree = degree.get(edge.target) ?? 0;
    if (sourceDegree >= maxEdgesPerNode || targetDegree >= maxEdgesPerNode) {
      continue;
    }
    degree.set(edge.source, sourceDegree + 1);
    degree.set(edge.target, targetDegree + 1);
    result.push(edge);
  }

  return result;
}

async function buildRelationEdges(params: {
  nodes: RelationNodeContext[];
  axes: GraphRelationAxis[];
  maxEdges: number;
  maxContextEdgesPerNode: number;
}): Promise<{
  edges: GraphEdge[];
  sessionEdgeCount: number;
  projectEdgeCount: number;
  sourceEdgeCount: number;
}> {
  if (params.nodes.length < 2 || params.axes.length === 0) {
    return { edges: [], sessionEdgeCount: 0, projectEdgeCount: 0, sourceEdgeCount: 0 };
  }

  const missingProjectSessionIds = new Set<string>();
  for (const node of params.nodes) {
    if (!node.projectKey && node.sessionKey) missingProjectSessionIds.add(node.sessionKey);
  }
  const sessionProjectLookup = await buildSessionProjectLookup([...missingProjectSessionIds]);
  const enrichedNodes = params.nodes.map((node) => ({
    ...node,
    projectKey:
      node.projectKey ?? (node.sessionKey ? sessionProjectLookup.get(node.sessionKey) : undefined),
  }));

  const sessionBuckets = new Map<string, RelationNodeContext[]>();
  const projectBuckets = new Map<string, RelationNodeContext[]>();
  const sourceBuckets = new Map<string, RelationNodeContext[]>();

  for (const node of enrichedNodes) {
    if (params.axes.includes("session") && node.sessionKey) {
      const bucket = sessionBuckets.get(node.sessionKey) ?? [];
      bucket.push(node);
      sessionBuckets.set(node.sessionKey, bucket);
    }
    if (params.axes.includes("project") && node.projectKey) {
      const bucket = projectBuckets.get(node.projectKey) ?? [];
      bucket.push(node);
      projectBuckets.set(node.projectKey, bucket);
    }
    if (params.axes.includes("source") && node.sourceDocIds) {
      for (const sourceDocId of node.sourceDocIds) {
        const bucket = sourceBuckets.get(sourceDocId) ?? [];
        bucket.push(node);
        sourceBuckets.set(sourceDocId, bucket);
      }
    }
  }

  const sessionEdges: GraphEdge[] = [];
  const projectEdges: GraphEdge[] = [];
  const sourceEdges: GraphEdge[] = [];

  for (const members of sessionBuckets.values()) {
    sessionEdges.push(
      ...buildContextEdgesForGroup({
        members,
        axis: "session",
        weight: 0.85,
        maxEdgesPerNode: params.maxContextEdgesPerNode,
      }),
    );
  }

  for (const members of projectBuckets.values()) {
    projectEdges.push(
      ...buildContextEdgesForGroup({
        members,
        axis: "project",
        weight: 0.7,
        maxEdgesPerNode: params.maxContextEdgesPerNode,
      }),
    );
  }

  for (const members of sourceBuckets.values()) {
    sourceEdges.push(
      ...buildContextEdgesForGroup({
        members,
        axis: "source",
        weight: 0.75,
        maxEdgesPerNode: params.maxContextEdgesPerNode,
      }),
    );
  }

  const sessionPairs = new Set(
    sessionEdges.map((edge) => unorderedPairKey(edge.source, edge.target)),
  );
  const dedupedProjectEdges = projectEdges.filter(
    (edge) => !sessionPairs.has(unorderedPairKey(edge.source, edge.target)),
  );
  const sessionProjectPairs = new Set(
    [...sessionEdges, ...dedupedProjectEdges].map((edge) =>
      unorderedPairKey(edge.source, edge.target),
    ),
  );
  const dedupedSourceEdges = sourceEdges.filter(
    (edge) => !sessionProjectPairs.has(unorderedPairKey(edge.source, edge.target)),
  );
  const merged = [...sessionEdges, ...dedupedProjectEdges, ...dedupedSourceEdges];
  const globallyCappedEdges = enforceGlobalPerNodeCap(merged, params.maxContextEdgesPerNode).slice(
    0,
    params.maxEdges,
  );

  let sessionEdgeCount = 0;
  let projectEdgeCount = 0;
  let sourceEdgeCount = 0;
  for (const edge of globallyCappedEdges) {
    if (edge.edgeKind === "session") sessionEdgeCount += 1;
    if (edge.edgeKind === "project") projectEdgeCount += 1;
    if (edge.edgeKind === "source") sourceEdgeCount += 1;
  }

  return {
    edges: globallyCappedEdges,
    sessionEdgeCount,
    projectEdgeCount,
    sourceEdgeCount,
  };
}

async function buildSemanticEdges(params: {
  nodeIds: string[];
  minSimilarity: number;
  topK: number;
  maxEdges: number;
}): Promise<GraphEdge[]> {
  if (params.nodeIds.length < 2) return [];

  const idsSql = sql.join(
    params.nodeIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const fetchLimit = Math.max(params.maxEdges, params.nodeIds.length * params.topK * 3);
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
  const edgeCounts = new Map<string, number>();
  const edges: GraphEdge[] = [];

  for (const row of rows) {
    const similarity = finiteOrFallback(row.similarity, 0);
    const sourceCount = edgeCounts.get(row.source_id) ?? 0;
    const targetCount = edgeCounts.get(row.target_id) ?? 0;
    if (sourceCount >= params.topK || targetCount >= params.topK) {
      continue;
    }

    edges.push({
      id: `semantic:${row.source_id}:${row.target_id}`,
      source: knowledgeNodeId(row.source_id),
      target: knowledgeNodeId(row.target_id),
      relationType: "semantic_near",
      edgeKind: "semantic",
      relationAxis: "semantic",
      derived: true,
      weight: Math.max(0.1, similarity),
    });
    edgeCounts.set(row.source_id, sourceCount + 1);
    edgeCounts.set(row.target_id, targetCount + 1);

    if (edges.length >= params.maxEdges) break;
  }

  return edges;
}

async function listCommunityLabelsByKeys(
  communityKeys: string[],
): Promise<Map<string, CommunityLabelRecord>> {
  const keys = [...new Set(communityKeys.filter((key) => key.trim().length > 0))];
  if (keys.length === 0) return new Map();
  let rows: Array<{
    communityKey: string;
    label: string;
    note: string | null;
    updatedAt: Date;
  }> = [];
  try {
    rows = await db
      .select({
        communityKey: knowledgeCommunityLabels.communityKey,
        label: knowledgeCommunityLabels.label,
        note: knowledgeCommunityLabels.note,
        updatedAt: knowledgeCommunityLabels.updatedAt,
      })
      .from(knowledgeCommunityLabels)
      .where(inArray(knowledgeCommunityLabels.communityKey, keys));
  } catch {
    return new Map();
  }

  const result = new Map<string, CommunityLabelRecord>();
  for (const row of rows) {
    result.set(row.communityKey, {
      communityKey: row.communityKey,
      label: row.label,
      note: row.note,
      updatedAt: row.updatedAt,
    });
  }
  return result;
}

function buildCommunitySummaries(params: {
  components: CommunityComponent[];
  nodes: GraphNode[];
  labelsByKey: Map<string, CommunityLabelRecord>;
  sourceRefCountByNodeId: Map<string, number>;
  compileSelectCountByNodeId: Map<string, number>;
  decayFactorByNodeId: Map<string, number>;
  distilledByNodeId: Map<string, boolean>;
}): GraphCommunitySummary[] {
  const nodeById = new Map(params.nodes.map((node) => [node.id, node]));
  const summaries: GraphCommunitySummary[] = [];
  for (const component of params.components) {
    const typeCounts: Record<string, number> = {};
    const statusCounts: Record<string, number> = {};
    let embeddedCount = 0;
    let compileSelectCount = 0;
    let staleNodeCount = 0;
    let sourceRefCount = 0;
    const observedMemberNodeIds = component.members.filter(
      (memberNodeId) => params.distilledByNodeId.get(memberNodeId) === true,
    );
    const healthMemberNodeIds =
      observedMemberNodeIds.length > 0 ? observedMemberNodeIds : component.members;
    const healthMemberNodeIdSet = new Set(healthMemberNodeIds);
    let activeCount = 0;

    for (const memberNodeId of component.members) {
      const node = nodeById.get(memberNodeId);
      if (!node) continue;
      incrementCount(typeCounts, node.group);
      incrementCount(statusCounts, node.status);
      if (node.embedded) embeddedCount += 1;
      if (healthMemberNodeIdSet.has(memberNodeId)) {
        if (node.status === "active") activeCount += 1;
        compileSelectCount += params.compileSelectCountByNodeId.get(memberNodeId) ?? 0;
      }
      const decayFactor = params.decayFactorByNodeId.get(memberNodeId) ?? 1;
      if (decayFactor < COMMUNITY_STALE_DECAY_THRESHOLD) staleNodeCount += 1;
      sourceRefCount += params.sourceRefCountByNodeId.get(memberNodeId) ?? 0;
    }

    const sourceRefDensity =
      component.communitySize > 0 ? sourceRefCount / component.communitySize : 0;
    const staleRatio = component.communitySize > 0 ? staleNodeCount / component.communitySize : 0;
    const health = {
      dead: activeCount > 0 && compileSelectCount === 0,
      stale: staleRatio >= COMMUNITY_STALE_RATIO_THRESHOLD,
      thinEvidence: sourceRefDensity < COMMUNITY_THIN_EVIDENCE_DENSITY_THRESHOLD,
    };
    const labelRow = params.labelsByKey.get(component.communityKey);
    const communityLabel = labelRow?.label?.trim() ? labelRow.label.trim() : component.communityId;
    summaries.push({
      communityId: component.communityId,
      communityKey: component.communityKey,
      communityLabel,
      communityRank: component.communityRank,
      size: component.communitySize,
      typeCounts,
      statusCounts,
      embeddedCount,
      compileSelectCount,
      staleNodeCount,
      sourceRefCount,
      sourceRefDensity,
      health,
      note: labelRow?.note ?? undefined,
      labelUpdatedAt: labelRow?.updatedAt?.toISOString(),
    });
  }
  return summaries.sort((a, b) => a.communityRank - b.communityRank);
}

function buildSupernodes(communities: GraphCommunitySummary[]): GraphSupernode[] {
  return communities.map((community) => ({
    id: community.communityId,
    label: community.communityLabel,
    communityKey: community.communityKey,
    size: community.size,
    communityRank: community.communityRank,
    health: community.health,
  }));
}

function buildSuperedges(params: {
  edges: GraphEdge[];
  assignmentByNodeId: Map<string, CommunityAssignment>;
}): GraphSuperedge[] {
  const countsByPair = new Map<string, { source: string; target: string; weight: number }>();
  for (const edge of params.edges) {
    const sourceCommunity = params.assignmentByNodeId.get(edge.source)?.communityId;
    const targetCommunity = params.assignmentByNodeId.get(edge.target)?.communityId;
    if (!sourceCommunity || !targetCommunity || sourceCommunity === targetCommunity) continue;
    const [left, right] =
      sourceCommunity < targetCommunity
        ? [sourceCommunity, targetCommunity]
        : [targetCommunity, sourceCommunity];
    const pairKey = `${left}::${right}`;
    const existing = countsByPair.get(pairKey);
    if (existing) {
      existing.weight += 1;
      continue;
    }
    countsByPair.set(pairKey, { source: left, target: right, weight: 1 });
  }

  return [...countsByPair.values()]
    .sort((a, b) => b.weight - a.weight || a.source.localeCompare(b.source))
    .map((edge) => ({
      id: `superedge:${edge.source}:${edge.target}`,
      source: edge.source,
      target: edge.target,
      weight: edge.weight,
    }));
}

function buildCommunityNodesWithLabels(params: {
  nodes: GraphNode[];
  assignments: Map<string, CommunityAssignment>;
  summariesById: Map<string, GraphCommunitySummary>;
}): GraphNode[] {
  return params.nodes.map((node) => {
    const assignment = params.assignments.get(node.id);
    if (!assignment) return node;
    const summary = params.summariesById.get(assignment.communityId);
    return {
      ...node,
      communityId: assignment.communityId,
      communityRank: assignment.communityRank,
      communitySize: assignment.communitySize,
      communityKey: assignment.communityKey,
      communityLabel: summary?.communityLabel ?? assignment.communityLabel,
    };
  });
}

function collectCommunityHealthCounts(communities: GraphCommunitySummary[]): {
  deadCommunityCount: number;
  staleCommunityCount: number;
  thinEvidenceCommunityCount: number;
} {
  let deadCommunityCount = 0;
  let staleCommunityCount = 0;
  let thinEvidenceCommunityCount = 0;
  for (const community of communities) {
    if (community.health.dead) deadCommunityCount += 1;
    if (community.health.stale) staleCommunityCount += 1;
    if (community.health.thinEvidence) thinEvidenceCommunityCount += 1;
  }
  return { deadCommunityCount, staleCommunityCount, thinEvidenceCommunityCount };
}

export async function buildGraphSnapshot(params: GraphSnapshotParams): Promise<{
  nodes: GraphNode[];
  edges: GraphEdge[];
  communities: GraphCommunitySummary[];
  supernodes: GraphSupernode[];
  superedges: GraphSuperedge[];
  stats: {
    visibleKnowledgeCount: number;
    totalKnowledgeCount: number;
    embeddedKnowledgeCount: number;
    semanticEdgeCount: number;
    sessionEdgeCount: number;
    projectEdgeCount: number;
    sourceEdgeCount: number;
    sourceNodeCount: number;
    evidenceEdgeCount: number;
    evidenceLinkedKnowledgeCount: number;
    evidenceUnlinkedKnowledgeCount: number;
    truncatedSourceNodeCount: number;
    relationEdgeCount: number;
    sourceRefCount: number;
    communityCount: number;
    largestCommunitySize: number;
    orphanNodeCount: number;
    deadCommunityCount: number;
    staleCommunityCount: number;
    thinEvidenceCommunityCount: number;
  };
}> {
  const statuses = resolveStatusFilter(params.status);
  const filters = statuses ? [inArray(knowledgeItems.status, statuses)] : [];
  const where = filters.length > 0 ? and(...filters) : undefined;
  const view = params.view ?? "relation";
  const sourceNodeLimit = Math.max(1, Math.min(2000, Math.trunc(params.sourceNodeLimit ?? 800)));
  const relationAxes: GraphRelationAxis[] = params.relationAxes?.length
    ? params.relationAxes
    : ["session", "project", "source"];
  const maxContextEdgesPerNode = Math.max(
    1,
    Math.min(10, Math.trunc(params.maxContextEdgesPerNode ?? 3)),
  );
  const importanceOrderExpr = normalizedImportanceExpr();

  const [knowledgeRows, statsRows] = await Promise.all([
    db
      .select({
        id: knowledgeItems.id,
        title: knowledgeItems.title,
        type: knowledgeItems.type,
        status: knowledgeItems.status,
        scope: knowledgeItems.scope,
        importance: knowledgeItems.importance,
        compileSelectCount: knowledgeItems.compileSelectCount,
        lastVerifiedAt: knowledgeItems.lastVerifiedAt,
        updatedAt: knowledgeItems.updatedAt,
        embedded: sql<boolean>`${knowledgeItems.embedding} is not null`,
        appliesTo: knowledgeItems.appliesTo,
        metadata: knowledgeItems.metadata,
      })
      .from(knowledgeItems)
      .where(where)
      .orderBy(desc(importanceOrderExpr), desc(knowledgeItems.updatedAt))
      .limit(params.limit),
    db
      .select({
        totalKnowledgeCount: sql<number>`count(*)::int`,
        embeddedKnowledgeCount: sql<number>`count(*) filter (where ${knowledgeItems.embedding} is not null)::int`,
      })
      .from(knowledgeItems)
      .where(where),
  ]);

  const nodeCandidates: GraphNode[] = [
    ...knowledgeRows.map((row) => ({
      id: knowledgeNodeId(row.id),
      label: row.title,
      kind: "knowledge" as const,
      group: row.type,
      weight: Math.max(0.2, toUnitKnowledgeScore(row.importance, 50)),
      status: row.status,
      embedded: Boolean(row.embedded),
    })),
  ];
  const compileSelectCountByNodeId = new Map<string, number>();
  const decayFactorByNodeId = new Map<string, number>();
  const distilledByNodeId = new Map<string, boolean>();
  for (const row of knowledgeRows) {
    const nodeId = knowledgeNodeId(row.id);
    const metadata = asRecord(row.metadata);
    compileSelectCountByNodeId.set(nodeId, Math.max(0, Math.trunc(row.compileSelectCount ?? 0)));
    distilledByNodeId.set(nodeId, isDistilledKnowledgeMetadata(metadata));
    decayFactorByNodeId.set(
      nodeId,
      computeDecayFactor({
        type: normalizeKnowledgeType(row.type),
        scope: normalizeKnowledgeScope(row.scope),
        lastVerifiedAt: row.lastVerifiedAt,
        updatedAt: row.updatedAt,
      }),
    );
  }
  const relationNodeContexts: RelationNodeContext[] = knowledgeRows.map((row) => {
    const appliesTo = asRecord(row.appliesTo);
    const metadata = asRecord(row.metadata);
    return {
      id: row.id,
      importance: normalizeKnowledgeScore(row.importance, 70),
      sessionKey: extractSessionKey(metadata),
      projectKey: pickProjectKey(appliesTo, metadata),
      sourceDocIds: sourceDocIdsFromMetadata(metadata),
    };
  });

  const nodeById = new Map<string, GraphNode>();
  for (const node of nodeCandidates) {
    if (!nodeById.has(node.id)) {
      nodeById.set(node.id, node);
    }
  }
  const nodes = [...nodeById.values()];
  const nodeRawIds = nodes.map((node) => node.id.replace(/^knowledge:/, ""));
  const nodeRawIdSet = new Set(nodeRawIds);

  // wiki source 軸用: knowledgeId → sources.id[] / legacy source URI[] のマップを構築
  const sourceDocIdsByKnowledge = new Map<string, string[]>();
  for (const node of relationNodeContexts) {
    if (node.sourceDocIds && node.sourceDocIds.length > 0) {
      sourceDocIdsByKnowledge.set(node.id, [...node.sourceDocIds]);
    }
  }
  if (view !== "semantic" && nodeRawIds.length > 0) {
    const sourceLinks = await db
      .select({
        knowledgeId: knowledgeSourceLinks.knowledgeId,
        sourceId: sourceFragments.sourceId,
      })
      .from(knowledgeSourceLinks)
      .innerJoin(
        sourceFragments,
        sql`${sourceFragments.id} = ${knowledgeSourceLinks.sourceFragmentId}`,
      )
      .where(inArray(knowledgeSourceLinks.knowledgeId, nodeRawIds));
    for (const row of sourceLinks) {
      const existing = sourceDocIdsByKnowledge.get(row.knowledgeId) ?? [];
      if (!existing.includes(row.sourceId)) existing.push(row.sourceId);
      sourceDocIdsByKnowledge.set(row.knowledgeId, existing);
    }
  }

  const enrichedRelationContexts = relationNodeContexts.map((node) => ({
    ...node,
    sourceDocIds: sourceDocIdsByKnowledge.get(node.id),
  }));

  const sourceRefCountByNodeId = new Map<string, number>();
  for (const nodeRawId of nodeRawIds) {
    sourceRefCountByNodeId.set(
      knowledgeNodeId(nodeRawId),
      sourceDocIdsByKnowledge.get(nodeRawId)?.length ?? 0,
    );
  }

  const idsSql = sql.join(
    nodeRawIds.map((id) => sql`${id}`),
    sql`, `,
  );

  const evidenceLinksPromise =
    view === "evidence" && nodeRawIds.length > 0
      ? db.execute(sql`
          select
            ${knowledgeSourceLinks.knowledgeId}::text as knowledge_id,
            ${sources.id}::text as source_id,
            ${sources.sourceKind} as source_kind,
            ${sources.uri} as source_uri,
            ${sources.title} as source_title,
            count(*)::int as link_count
          from ${knowledgeSourceLinks}
          inner join ${sourceFragments}
            on ${sourceFragments.id} = ${knowledgeSourceLinks.sourceFragmentId}
          inner join ${sources}
            on ${sources.id} = ${sourceFragments.sourceId}
          where ${knowledgeSourceLinks.knowledgeId} in (${idsSql})
          group by
            ${knowledgeSourceLinks.knowledgeId},
            ${sources.id},
            ${sources.sourceKind},
            ${sources.uri},
            ${sources.title}
        `)
      : Promise.resolve({
          rows: [] as EvidenceLinkRow[],
        });

  const [relationResult, semanticEdges, sourceRefRows, evidenceLinkQuery] = await Promise.all([
    view === "semantic" || view === "evidence"
      ? Promise.resolve({
          edges: [],
          sessionEdgeCount: 0,
          projectEdgeCount: 0,
          sourceEdgeCount: 0,
        })
      : buildRelationEdges({
          nodes: enrichedRelationContexts.filter((node) => nodeRawIdSet.has(node.id)),
          axes: relationAxes,
          maxEdges: params.limit * 2,
          maxContextEdgesPerNode,
        }),
    view === "semantic"
      ? buildSemanticEdges({
          nodeIds: nodeRawIds,
          minSimilarity: params.minSimilarity ?? 0.72,
          topK: params.semanticTopK ?? 3,
          maxEdges: params.limit * 2,
        })
      : Promise.resolve([]),
    nodeRawIds.length === 0
      ? [{ sourceRefCount: 0 }]
      : db
          .select({
            sourceRefCount: sql<number>`count(*)::int`,
          })
          .from(knowledgeSourceLinks)
          .where(inArray(knowledgeSourceLinks.knowledgeId, nodeRawIds)),
    evidenceLinksPromise,
  ]);

  const evidenceRows = evidenceLinkQuery.rows as EvidenceLinkRow[];
  const evidenceLinkedKnowledgeIdSet = new Set<string>();
  const sourceInfoById = new Map<
    string,
    {
      sourceKind: string;
      sourceUri: string;
      sourceTitle: string | null;
      linkedKnowledgeIds: Set<string>;
    }
  >();
  for (const row of evidenceRows) {
    evidenceLinkedKnowledgeIdSet.add(row.knowledge_id);
    const sourceInfo = sourceInfoById.get(row.source_id) ?? {
      sourceKind: row.source_kind,
      sourceUri: row.source_uri,
      sourceTitle: row.source_title,
      linkedKnowledgeIds: new Set<string>(),
    };
    sourceInfo.linkedKnowledgeIds.add(row.knowledge_id);
    sourceInfoById.set(row.source_id, sourceInfo);
  }

  const sourceOrder = [...sourceInfoById.entries()]
    .map(([sourceId, info]) => ({ sourceId, linkedKnowledgeCount: info.linkedKnowledgeIds.size }))
    .sort(
      (a, b) =>
        b.linkedKnowledgeCount - a.linkedKnowledgeCount || a.sourceId.localeCompare(b.sourceId),
    );
  const visibleSourceIds = new Set(
    sourceOrder.slice(0, sourceNodeLimit).map((entry) => entry.sourceId),
  );
  const truncatedSourceNodeCount = Math.max(0, sourceInfoById.size - visibleSourceIds.size);

  const sourceNodes: GraphNode[] =
    view === "evidence"
      ? sourceOrder
          .filter((entry) => visibleSourceIds.has(entry.sourceId))
          .reduce<GraphNode[]>((acc, entry) => {
            const sourceInfo = sourceInfoById.get(entry.sourceId);
            if (!sourceInfo) return acc;
            acc.push({
              id: sourceNodeId(entry.sourceId),
              label: sourceInfo.sourceTitle?.trim() || sourceInfo.sourceUri,
              kind: "source" as const,
              group: "source",
              weight: Math.max(
                0.3,
                Math.min(2.2, 0.42 + Math.log2(entry.linkedKnowledgeCount + 1) * 0.25),
              ),
              status: "active",
              embedded: true,
              sourceId: entry.sourceId,
              sourceKind: sourceInfo.sourceKind,
              sourceUri: sourceInfo.sourceUri,
              sourceTitle: sourceInfo.sourceTitle,
              linkedKnowledgeCount: entry.linkedKnowledgeCount,
            });
            return acc;
          }, [])
      : [];

  const evidenceEdges: GraphEdge[] =
    view === "evidence"
      ? evidenceRows
          .filter((row) => visibleSourceIds.has(row.source_id))
          .map((row) => {
            const linkCount = Math.max(1, Math.trunc(finiteOrFallback(row.link_count, 1)));
            return {
              id: `evidence:${row.knowledge_id}:${row.source_id}`,
              source: knowledgeNodeId(row.knowledge_id),
              target: sourceNodeId(row.source_id),
              relationType: "linked_source",
              edgeKind: "evidence",
              relationAxis: "evidence",
              derived: false,
              weight: Math.min(1, 0.35 + Math.log2(linkCount + 1) * 0.2),
            };
          })
      : [];

  const relationEdges = relationResult.edges;
  const edges =
    view === "semantic" ? semanticEdges : view === "evidence" ? evidenceEdges : relationEdges;
  const community =
    view === "community"
      ? buildCommunityAssignments({
          nodes,
          edges: relationEdges,
          minEdgeWeight: COMMUNITY_MIN_EDGE_WEIGHT,
        })
      : {
          assignments: new Map<string, CommunityAssignment>(),
          components: [] as CommunityComponent[],
          communityCount: 0,
          largestCommunitySize: 0,
          orphanNodeCount: 0,
        };
  const labelsByKey =
    view === "community" && community.components.length > 0
      ? await listCommunityLabelsByKeys(
          community.components.map((component) => component.communityKey),
        )
      : new Map<string, CommunityLabelRecord>();
  const communities =
    view === "community"
      ? buildCommunitySummaries({
          components: community.components,
          nodes,
          labelsByKey,
          sourceRefCountByNodeId,
          compileSelectCountByNodeId,
          decayFactorByNodeId,
          distilledByNodeId,
        })
      : [];
  const summariesById = new Map(communities.map((summary) => [summary.communityId, summary]));
  const graphKnowledgeNodes =
    view === "community"
      ? buildCommunityNodesWithLabels({
          nodes,
          assignments: community.assignments,
          summariesById,
        })
      : nodes;
  const nodesWithCommunity =
    view === "evidence" ? [...graphKnowledgeNodes, ...sourceNodes] : graphKnowledgeNodes;
  const supernodes = view === "community" ? buildSupernodes(communities) : [];
  const superedges =
    view === "community"
      ? buildSuperedges({ edges: relationEdges, assignmentByNodeId: community.assignments })
      : [];
  const stats = statsRows[0] ?? { totalKnowledgeCount: 0, embeddedKnowledgeCount: 0 };
  const relationSourceRefCount = [...sourceDocIdsByKnowledge.values()].reduce(
    (sum, refs) => sum + refs.length,
    0,
  );
  const relationEdgeCount =
    relationResult.sessionEdgeCount +
    relationResult.projectEdgeCount +
    relationResult.sourceEdgeCount;
  const healthCounts = collectCommunityHealthCounts(communities);
  const evidenceLinkedKnowledgeCount = view === "evidence" ? evidenceLinkedKnowledgeIdSet.size : 0;
  const evidenceUnlinkedKnowledgeCount =
    view === "evidence" ? Math.max(0, nodes.length - evidenceLinkedKnowledgeCount) : 0;

  return {
    nodes: nodesWithCommunity,
    edges,
    communities,
    supernodes,
    superedges,
    stats: {
      visibleKnowledgeCount: nodes.length,
      totalKnowledgeCount: finiteOrFallback(stats.totalKnowledgeCount, 0),
      embeddedKnowledgeCount: finiteOrFallback(stats.embeddedKnowledgeCount, 0),
      semanticEdgeCount: semanticEdges.length,
      sessionEdgeCount: relationResult.sessionEdgeCount,
      projectEdgeCount: relationResult.projectEdgeCount,
      sourceEdgeCount: relationResult.sourceEdgeCount,
      sourceNodeCount: sourceNodes.length,
      evidenceEdgeCount: evidenceEdges.length,
      evidenceLinkedKnowledgeCount,
      evidenceUnlinkedKnowledgeCount,
      truncatedSourceNodeCount,
      relationEdgeCount,
      sourceRefCount: Math.max(
        relationSourceRefCount,
        finiteOrFallback(sourceRefRows[0]?.sourceRefCount, 0),
      ),
      communityCount: community.communityCount,
      largestCommunitySize: community.largestCommunitySize,
      orphanNodeCount: community.orphanNodeCount,
      deadCommunityCount: healthCounts.deadCommunityCount,
      staleCommunityCount: healthCounts.staleCommunityCount,
      thinEvidenceCommunityCount: healthCounts.thinEvidenceCommunityCount,
    },
  };
}

export async function listGraphCommunityLabels(params: {
  limit?: number;
  status?: GraphStatusFilter;
  relationAxes?: GraphRelationAxis[];
}): Promise<
  Array<{
    communityKey: string;
    communityId: string;
    communityLabel: string;
    communityRank: number;
    size: number;
    note?: string;
    labelUpdatedAt?: string;
  }>
> {
  const snapshot = await buildGraphSnapshot({
    limit: Math.max(1, Math.min(1000, Math.trunc(params.limit ?? 1000))),
    status: params.status ?? "current",
    view: "community",
    relationAxes: params.relationAxes,
    communityDisplay: "detail",
  });
  return snapshot.communities.map((community) => ({
    communityKey: community.communityKey,
    communityId: community.communityId,
    communityLabel: community.communityLabel,
    communityRank: community.communityRank,
    size: community.size,
    note: community.note,
    labelUpdatedAt: community.labelUpdatedAt,
  }));
}

export async function upsertGraphCommunityLabel(input: {
  communityKey: string;
  label: string;
  note?: string | null;
}): Promise<CommunityLabelRecord> {
  const communityKey = input.communityKey.trim().toLowerCase();
  const label = input.label.trim();
  const noteValue =
    typeof input.note === "string" && input.note.trim().length > 0 ? input.note.trim() : null;
  const now = new Date();
  await db
    .insert(knowledgeCommunityLabels)
    .values({
      communityKey,
      label,
      note: noteValue,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: knowledgeCommunityLabels.communityKey,
      set: {
        label,
        note: noteValue,
        updatedAt: now,
      },
    });

  const row = await db
    .select({
      communityKey: knowledgeCommunityLabels.communityKey,
      label: knowledgeCommunityLabels.label,
      note: knowledgeCommunityLabels.note,
      updatedAt: knowledgeCommunityLabels.updatedAt,
    })
    .from(knowledgeCommunityLabels)
    .where(eq(knowledgeCommunityLabels.communityKey, communityKey))
    .limit(1);
  const saved = row[0];
  if (!saved) {
    return {
      communityKey,
      label,
      note: noteValue,
      updatedAt: now,
    };
  }
  return {
    communityKey: saved.communityKey,
    label: saved.label,
    note: saved.note,
    updatedAt: saved.updatedAt,
  };
}

/**
 * ノードクリック時に詳細を取得する関数。
 * knowledge: prefix を取り除いた生 ID を受け取る。
 */
export async function fetchGraphNodeDetail(rawId: string): Promise<GraphNodeDetail | null> {
  const row = await db.query.knowledgeItems.findFirst({
    where: (t, { eq }) => eq(t.id, rawId),
    columns: {
      id: true,
      title: true,
      body: true,
      type: true,
      status: true,
      confidence: true,
      importance: true,
      embedding: false,
    },
  });
  if (!row) return null;
  return {
    id: knowledgeNodeId(row.id),
    label: row.title,
    kind: "knowledge" as const,
    group: row.type,
    detail: `${row.type} / ${row.status}`,
    weight: Math.max(0.2, toUnitKnowledgeScore(row.importance, 50)),
    status: row.status,
    confidence: normalizeKnowledgeScore(row.confidence, 70),
    importance: normalizeKnowledgeScore(row.importance, 70),
    bodyPreview: preview(row.body),
    embedded: false, // クリック時は画面上の embedded 状態を流用するため概算
  };
}
