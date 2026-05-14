import { desc } from "drizzle-orm";
import { db } from "../../../src/db/index.js";
import {
  codeSymbols,
  evidenceSources,
  knowledgeItems,
  relations,
  sources,
} from "../../../src/db/schema.js";

export type GraphNode = {
  id: string;
  label: string;
  kind: "knowledge" | "source" | "code";
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

function normalizeKind(kind: string): "knowledge" | "source" | "code" | string {
  if (kind === "evidence") return "source";
  return kind;
}

export async function buildGraphSnapshot(limit: number): Promise<{
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: {
    knowledgeCount: number;
    sourceCount: number;
    codeSymbolCount: number;
    relationCount: number;
  };
}> {
  const [knowledgeRows, sourceRows, legacySourceRows, symbolRows, relationRows] = await Promise.all(
    [
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
          id: evidenceSources.id,
          uri: evidenceSources.uri,
          title: evidenceSources.title,
          sourceKind: evidenceSources.sourceKind,
        })
        .from(evidenceSources)
        .orderBy(desc(evidenceSources.updatedAt))
        .limit(limit),
      db
        .select({
          id: codeSymbols.id,
          filePath: codeSymbols.filePath,
          symbolName: codeSymbols.symbolName,
          symbolKind: codeSymbols.symbolKind,
        })
        .from(codeSymbols)
        .orderBy(desc(codeSymbols.updatedAt))
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
    ],
  );

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
    ...legacySourceRows.map((row) => ({
      id: `source:${row.id}`,
      label: row.title || row.uri.split("/").at(-1) || row.uri,
      kind: "source" as const,
      group: row.sourceKind,
      detail: row.uri,
      weight: 0.45,
    })),
    ...symbolRows.map((row) => ({
      id: `code:${row.id}`,
      label: row.symbolName,
      kind: "code" as const,
      group: row.symbolKind,
      detail: row.filePath,
      weight: 0.55,
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
      sourceCount: sourceRows.length + legacySourceRows.length,
      codeSymbolCount: symbolRows.length,
      relationCount: edges.length,
    },
  };
}
