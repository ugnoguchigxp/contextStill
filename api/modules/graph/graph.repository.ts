import { and, desc, inArray, sql } from "drizzle-orm";
import { db } from "../../../src/db/index.js";
import { knowledgeItems, knowledgeSourceLinks, relations } from "../../../src/db/schema.js";

export type GraphNode = {
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
  edgeKind: "relation" | "semantic";
  weight: number;
  detail: string;
};

export type GraphStatusFilter = "current" | "active" | "draft" | "deprecated" | "all";

export type GraphEdgeMode = "semantic" | "relations" | "both";

export type GraphSnapshotParams = {
  limit: number;
  status?: GraphStatusFilter;
  edgeMode?: GraphEdgeMode;
  minSimilarity?: number;
  semanticTopK?: number;
};

const knowledgeRelationKinds = ["knowledge", "knowledge_item", "knowledge_items"];

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

function knowledgeNodeId(id: string): string {
  return `knowledge:${id}`;
}

function unorderedPairKey(source: string, target: string): string {
  return [source, target].sort().join("::");
}

async function buildRelationEdges(nodeIds: string[], limit: number): Promise<GraphEdge[]> {
  if (nodeIds.length === 0) return [];

  const rows = await db
    .select({
      id: relations.id,
      sourceKind: relations.sourceKind,
      sourceId: relations.sourceId,
      targetKind: relations.targetKind,
      targetId: relations.targetId,
      relationType: relations.relationType,
      confidence: relations.confidence,
    })
    .from(relations)
    .where(
      and(
        inArray(relations.sourceKind, knowledgeRelationKinds),
        inArray(relations.targetKind, knowledgeRelationKinds),
        inArray(relations.sourceId, nodeIds),
        inArray(relations.targetId, nodeIds),
      ),
    )
    .orderBy(desc(relations.confidence), desc(relations.createdAt))
    .limit(limit);

  return rows.map((relation) => {
    const weight = Math.max(0.1, finiteOrFallback(relation.confidence, 0.5));
    return {
      id: relation.id,
      source: knowledgeNodeId(relation.sourceId),
      target: knowledgeNodeId(relation.targetId),
      relationType: relation.relationType,
      edgeKind: "relation" as const,
      weight,
      detail: `${relation.relationType} (${Math.round(weight * 100)}%)`,
    };
  });
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
    if (sourceCount >= params.topK && targetCount >= params.topK) {
      continue;
    }

    edges.push({
      id: `semantic:${row.source_id}:${row.target_id}`,
      source: knowledgeNodeId(row.source_id),
      target: knowledgeNodeId(row.target_id),
      relationType: "semantic_near",
      edgeKind: "semantic",
      weight: Math.max(0.1, similarity),
      detail: `${Math.round(similarity * 100)}% semantic similarity`,
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
    relationEdgeCount: number;
    sourceRefCount: number;
  };
}> {
  const statuses = resolveStatusFilter(params.status);
  const filters = statuses ? [inArray(knowledgeItems.status, statuses)] : [];
  const where = filters.length > 0 ? and(...filters) : undefined;
  const edgeMode = params.edgeMode ?? "both";

  const [knowledgeRows, statsRows] = await Promise.all([
    db
      .select({
        id: knowledgeItems.id,
        title: knowledgeItems.title,
        body: knowledgeItems.body,
        type: knowledgeItems.type,
        status: knowledgeItems.status,
        confidence: knowledgeItems.confidence,
        importance: knowledgeItems.importance,
        embedded: sql<boolean>`${knowledgeItems.embedding} is not null`,
      })
      .from(knowledgeItems)
      .where(where)
      .orderBy(desc(knowledgeItems.importance), desc(knowledgeItems.updatedAt))
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
      detail: `${row.type} / ${row.status}`,
      weight: Math.max(0.2, finiteOrFallback(row.importance, 0.5)),
      status: row.status,
      confidence: finiteOrFallback(row.confidence, 0.5),
      importance: finiteOrFallback(row.importance, 0.5),
      bodyPreview: preview(row.body),
      embedded: Boolean(row.embedded),
    })),
  ];

  const nodeById = new Map<string, GraphNode>();
  for (const node of nodeCandidates) {
    if (!nodeById.has(node.id)) {
      nodeById.set(node.id, node);
    }
  }
  const nodes = [...nodeById.values()];
  const nodeRawIds = nodes.map((node) => node.id.replace(/^knowledge:/, ""));
  const [relationEdges, semanticEdges, sourceRefRows] = await Promise.all([
    edgeMode === "semantic" ? [] : buildRelationEdges(nodeRawIds, params.limit * 2),
    edgeMode === "relations"
      ? []
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
  const relationPairs = new Set(
    relationEdges.map((edge) => unorderedPairKey(edge.source, edge.target)),
  );
  const dedupedSemanticEdges = semanticEdges.filter(
    (edge) => !relationPairs.has(unorderedPairKey(edge.source, edge.target)),
  );
  const edges = [...relationEdges, ...dedupedSemanticEdges];
  const stats = statsRows[0] ?? { totalKnowledgeCount: 0, embeddedKnowledgeCount: 0 };

  return {
    nodes,
    edges,
    stats: {
      visibleKnowledgeCount: nodes.length,
      totalKnowledgeCount: finiteOrFallback(stats.totalKnowledgeCount, 0),
      embeddedKnowledgeCount: finiteOrFallback(stats.embeddedKnowledgeCount, 0),
      semanticEdgeCount: dedupedSemanticEdges.length,
      relationEdgeCount: relationEdges.length,
      sourceRefCount: finiteOrFallback(sourceRefRows[0]?.sourceRefCount, 0),
    },
  };
}
