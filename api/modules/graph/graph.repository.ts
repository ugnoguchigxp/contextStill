import { desc } from "drizzle-orm";
import { db } from "../../../src/db/index.js";
import { knowledgeItems, relations, sources, vibeMemories } from "../../../src/db/schema.js";

export type GraphNode = {
  id: string;
  label: string;
  kind: "knowledge" | "source" | "vibe_memory";
  group: string;
  detail: string;
  weight: number;
};

export type GraphEdge = {
  id: string;
  source: string;
  target: string;
  relationType: string;
  weight: number;
};

function normalizeKind(kind: string): "knowledge" | "source" | "vibe_memory" | string {
  return kind;
}

export async function buildGraphSnapshot(limit: number): Promise<{
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: {
    knowledgeCount: number;
    sourceCount: number;
    vibeMemoryCount: number;
    relationCount: number;
  };
}> {
  const [knowledgeRows, sourceRows, memoryRows, relationRows] = await Promise.all([
    db
      .select({
        id: knowledgeItems.id,
        title: knowledgeItems.title,
        type: knowledgeItems.type,
        status: knowledgeItems.status,
        importance: knowledgeItems.importance,
        metadata: knowledgeItems.metadata,
      })
      .from(knowledgeItems)
      .orderBy(desc(knowledgeItems.importance), desc(knowledgeItems.updatedAt))
      .limit(limit),
    db
      .select({
        id: sources.id,
        uri: sources.uri,
        title: sources.title,
        sourceKind: sources.sourceKind,
      })
      .from(sources)
      .orderBy(desc(sources.updatedAt))
      .limit(limit),
    db
      .select({
        id: vibeMemories.id,
        sessionId: vibeMemories.sessionId,
        content: vibeMemories.content,
        memoryType: vibeMemories.memoryType,
      })
      .from(vibeMemories)
      .orderBy(desc(vibeMemories.createdAt))
      .limit(limit),
    db
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
      .orderBy(desc(relations.createdAt))
      .limit(limit * 2),
  ]);

  const nodeCandidates: GraphNode[] = [
    ...knowledgeRows.map((row) => ({
      id: `knowledge:${row.id}`,
      label: row.title,
      kind: "knowledge" as const,
      group: row.type,
      detail: `${row.type} / ${row.status}`,
      weight: Math.max(0.2, Number(row.importance) || 0.5),
    })),
    ...sourceRows.map((row) => ({
      id: `source:${row.id}`,
      label: row.title || row.uri.split("/").at(-1) || row.uri,
      kind: "source" as const,
      group: row.sourceKind,
      detail: row.uri,
      weight: 0.45,
    })),
    ...memoryRows.map((row) => ({
      id: `vibe_memory:${row.id}`,
      label: row.content.slice(0, 32),
      kind: "vibe_memory" as const,
      group: row.memoryType,
      detail: `Session: ${row.sessionId}`,
      weight: 0.5,
    })),
  ];

  const nodeById = new Map<string, GraphNode>();
  for (const node of nodeCandidates) {
    if (!nodeById.has(node.id)) {
      nodeById.set(node.id, node);
    }
  }
  const nodes = [...nodeById.values()];
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges: GraphEdge[] = relationRows
    .map((relation) => ({
      id: relation.id,
      source: `${normalizeKind(relation.sourceKind)}:${relation.sourceId}`,
      target: `${normalizeKind(relation.targetKind)}:${relation.targetId}`,
      relationType: relation.relationType,
      weight: Math.max(0.1, Number(relation.confidence) || 0.5),
    }))
    .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));

  return {
    nodes,
    edges,
    stats: {
      knowledgeCount: knowledgeRows.length,
      sourceCount: sourceRows.length,
      vibeMemoryCount: memoryRows.length,
      relationCount: edges.length,
    },
  };
}
