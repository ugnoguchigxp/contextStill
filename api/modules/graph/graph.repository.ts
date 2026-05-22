import { and, desc, inArray, sql } from "drizzle-orm";
import { db } from "../../../src/db/index.js";
import {
  knowledgeItems,
  knowledgeSourceLinks,
  sourceFragments,
  vibeMemories,
} from "../../../src/db/schema.js";
import { normalizeKnowledgeScore, toUnitKnowledgeScore } from "../../../src/lib/score-scale.js";
import { normalizeRepoKey } from "../../../src/modules/context-compiler/query-context.js";

/** グラフ表示専用の軽量ノード型（body 等の重いフィールドを除外） */
export type GraphNode = {
  id: string;
  label: string;
  kind: "knowledge";
  group: string;
  weight: number;
  status: string;
  embedded: boolean;
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
};

export type GraphEdge = {
  id: string;
  source: string;
  target: string;
  relationType: string;
  edgeKind: "semantic" | "session" | "project" | "source";
  relationAxis: "semantic" | "session" | "project" | "source";
  derived: boolean;
  weight: number;
};

type GraphStatusFilter = "current" | "active" | "draft" | "deprecated" | "all";

type GraphViewMode = "relation" | "semantic";
export type GraphRelationAxis = "session" | "project" | "source";

export type GraphSnapshotParams = {
  limit: number;
  status?: GraphStatusFilter;
  view?: GraphViewMode;
  relationAxes?: GraphRelationAxis[];
  minSimilarity?: number;
  semanticTopK?: number;
  maxContextEdgesPerNode?: number;
};

type RelationNodeContext = {
  id: string;
  importance: number;
  sessionKey?: string;
  projectKey?: string;
  sourceDocIds?: string[];
};

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

function unorderedPairKey(source: string, target: string): string {
  return [source, target].sort().join("::");
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

export async function buildGraphSnapshot(params: GraphSnapshotParams): Promise<{
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: {
    visibleKnowledgeCount: number;
    totalKnowledgeCount: number;
    embeddedKnowledgeCount: number;
    semanticEdgeCount: number;
    sessionEdgeCount: number;
    projectEdgeCount: number;
    sourceEdgeCount: number;
    relationEdgeCount: number;
    sourceRefCount: number;
  };
}> {
  const statuses = resolveStatusFilter(params.status);
  const filters = statuses ? [inArray(knowledgeItems.status, statuses)] : [];
  const where = filters.length > 0 ? and(...filters) : undefined;
  const view = params.view ?? "relation";
  const relationAxes: GraphRelationAxis[] = params.relationAxes?.length
    ? params.relationAxes
    : ["session", "project"];
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
        importance: knowledgeItems.importance,
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
  if (view === "relation" && nodeRawIds.length > 0) {
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

  const [relationResult, semanticEdges, sourceRefRows] = await Promise.all([
    view === "semantic"
      ? Promise.resolve({ edges: [], sessionEdgeCount: 0, projectEdgeCount: 0, sourceEdgeCount: 0 })
      : buildRelationEdges({
          nodes: enrichedRelationContexts.filter((node) => nodeRawIdSet.has(node.id)),
          axes: relationAxes,
          maxEdges: params.limit * 2,
          maxContextEdgesPerNode,
        }),
    view === "relation"
      ? Promise.resolve([])
      : buildSemanticEdges({
          nodeIds: nodeRawIds,
          minSimilarity: params.minSimilarity ?? 0.72,
          topK: params.semanticTopK ?? 3,
          maxEdges: params.limit * 2,
        }),
    nodeRawIds.length === 0
      ? [{ sourceRefCount: 0 }]
      : db
          .select({
            sourceRefCount: sql<number>`count(*)::int`,
          })
          .from(knowledgeSourceLinks)
          .where(inArray(knowledgeSourceLinks.knowledgeId, nodeRawIds)),
  ]);
  const relationEdges = relationResult.edges;
  const edges = view === "semantic" ? semanticEdges : relationEdges;
  const stats = statsRows[0] ?? { totalKnowledgeCount: 0, embeddedKnowledgeCount: 0 };
  const relationSourceRefCount = [...sourceDocIdsByKnowledge.values()].reduce(
    (sum, refs) => sum + refs.length,
    0,
  );
  const relationEdgeCount =
    relationResult.sessionEdgeCount +
    relationResult.projectEdgeCount +
    relationResult.sourceEdgeCount;

  return {
    nodes,
    edges,
    stats: {
      visibleKnowledgeCount: nodes.length,
      totalKnowledgeCount: finiteOrFallback(stats.totalKnowledgeCount, 0),
      embeddedKnowledgeCount: finiteOrFallback(stats.embeddedKnowledgeCount, 0),
      semanticEdgeCount: semanticEdges.length,
      sessionEdgeCount: relationResult.sessionEdgeCount,
      projectEdgeCount: relationResult.projectEdgeCount,
      sourceEdgeCount: relationResult.sourceEdgeCount,
      relationEdgeCount,
      sourceRefCount: Math.max(
        relationSourceRefCount,
        finiteOrFallback(sourceRefRows[0]?.sourceRefCount, 0),
      ),
    },
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
