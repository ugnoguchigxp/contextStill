import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import {
  fetchGraphSnapshot,
  type GraphEdgeMode,
  type GraphNode,
  type GraphStatusFilter,
} from "../repositories/admin.repository";

const nodeColors: Record<string, string> = {
  rule: "#14b8a6",
  procedure: "#60a5fa",
};

type PositionedNode = GraphNode & { x: number; y: number };

function layoutNodes(nodes: GraphNode[]): PositionedNode[] {
  if (nodes.length === 0) return [];
  if (nodes.length === 1) {
    return [{ ...nodes[0], x: 380, y: 210 }];
  }
  const centerX = 380;
  const centerY = 210;
  const radius = 145;
  return nodes.map((node, index) => {
    const angle = (index / nodes.length) * Math.PI * 2 - Math.PI / 2;
    const laneOffset = node.group === "rule" ? -28 : 28;
    return {
      ...node,
      x: centerX + Math.cos(angle) * (radius + laneOffset),
      y: centerY + Math.sin(angle) * (radius + laneOffset),
    };
  });
}

function truncate(value: string, max = 18) {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

export function GraphPage() {
  const [statusFilter, setStatusFilter] = useState<GraphStatusFilter>("current");
  const [edgeMode, setEdgeMode] = useState<GraphEdgeMode>("both");
  const graph = useQuery({
    queryKey: ["graph", 160, statusFilter, edgeMode],
    queryFn: () =>
      fetchGraphSnapshot({
        limit: 160,
        status: statusFilter,
        edgeMode,
      }),
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const nodes = useMemo(() => layoutNodes(graph.data?.nodes ?? []), [graph.data?.nodes]);
  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const selected = selectedId ? nodeById.get(selectedId) : null;
  const activeId = selectedId ?? hoveredId;
  const showAllLabels = nodes.length <= 24;

  return (
    <div className="page-stack">
      <section className="page-heading">
        <div>
          <h1>Knowledge Graph</h1>
          <p>蒸留されたKnowledgeの距離と明示relationを確認します。</p>
        </div>
        <div className="graph-controls">
          <label htmlFor="graph-status-filter">
            <span>Status</span>
            <Select
              id="graph-status-filter"
              value={statusFilter}
              onChange={(event) => {
                setSelectedId(null);
                setStatusFilter(event.target.value as GraphStatusFilter);
              }}
            >
              <option value="current">Current</option>
              <option value="active">Active</option>
              <option value="draft">Draft</option>
              <option value="deprecated">Deprecated</option>
              <option value="all">All</option>
            </Select>
          </label>
          <label htmlFor="graph-edge-mode">
            <span>Edges</span>
            <Select
              id="graph-edge-mode"
              value={edgeMode}
              onChange={(event) => {
                setSelectedId(null);
                setEdgeMode(event.target.value as GraphEdgeMode);
              }}
            >
              <option value="both">Semantic + relations</option>
              <option value="semantic">Semantic only</option>
              <option value="relations">Relations only</option>
            </Select>
          </label>
        </div>
      </section>

      <div className="graph-layout">
        <Card>
          <CardHeader>
            <CardTitle>Knowledge Distance Map</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="graph-stage">
              <svg viewBox="0 0 760 420" role="img" aria-label="memory-router graph">
                <g>
                  {graph.data?.edges.map((edge) => {
                    const source = nodeById.get(edge.source);
                    const target = nodeById.get(edge.target);
                    if (!source || !target) return null;
                    return (
                      <line
                        key={edge.id}
                        x1={source.x}
                        y1={source.y}
                        x2={target.x}
                        y2={target.y}
                        className={`graph-edge ${edge.edgeKind}`}
                        strokeWidth={Math.max(1, edge.weight * 3)}
                      >
                        <title>{edge.detail}</title>
                      </line>
                    );
                  })}
                </g>
                <g>
                  {nodes.map((node) => {
                    const active = activeId === node.id;
                    return (
                      <a
                        key={node.id}
                        className={`graph-node ${active ? "active" : ""}`}
                        href={`#${node.id}`}
                        aria-label={`select ${node.label}`}
                        onMouseEnter={() => setHoveredId(node.id)}
                        onMouseLeave={() => setHoveredId(null)}
                        onClick={(event) => {
                          event.preventDefault();
                          setSelectedId(node.id);
                        }}
                      >
                        <circle
                          cx={node.x}
                          cy={node.y}
                          r={12 + node.weight * 8}
                          fill={nodeColors[node.group] ?? nodeColors.rule}
                          opacity={active ? 1 : 0.82}
                        >
                          <title>{`${node.label} / ${node.detail}`}</title>
                        </circle>
                        {showAllLabels || active ? (
                          <text x={node.x} y={node.y + 28} textAnchor="middle">
                            {truncate(node.label)}
                          </text>
                        ) : null}
                      </a>
                    );
                  })}
                </g>
              </svg>
              {nodes.length === 0 ? (
                <div className="graph-empty">表示できるknowledge nodeはまだありません。</div>
              ) : null}
            </div>
          </CardContent>
        </Card>

        <aside className="graph-side">
          <Card>
            <CardHeader>
              <CardTitle>Stats</CardTitle>
            </CardHeader>
            <CardContent className="runtime-list">
              <div>
                <span>Visible knowledge</span>
                <strong>{graph.data?.stats.visibleKnowledgeCount ?? 0}</strong>
              </div>
              <div>
                <span>Total in filter</span>
                <strong>{graph.data?.stats.totalKnowledgeCount ?? 0}</strong>
              </div>
              <div>
                <span>Embedded</span>
                <strong>{graph.data?.stats.embeddedKnowledgeCount ?? 0}</strong>
              </div>
              <div>
                <span>Semantic edges</span>
                <strong>{graph.data?.stats.semanticEdgeCount ?? 0}</strong>
              </div>
              <div>
                <span>Relation edges</span>
                <strong>{graph.data?.stats.relationEdgeCount ?? 0}</strong>
              </div>
              <div>
                <span>Source refs</span>
                <strong>{graph.data?.stats.sourceRefCount ?? 0}</strong>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Legend</CardTitle>
            </CardHeader>
            <CardContent className="graph-legend">
              <span>
                <i className="legend-dot rule" />
                Rule
              </span>
              <span>
                <i className="legend-dot procedure" />
                Procedure
              </span>
              <span className="row-subtext">
                Vibe MemoryはGraphノードではなく蒸留元として扱います。
              </span>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Selected</CardTitle>
            </CardHeader>
            <CardContent className="selected-node">
              {selected ? (
                <>
                  <div className="selected-badges">
                    <Badge>{selected.group}</Badge>
                    <Badge variant="outline">{selected.status}</Badge>
                    <Badge variant={selected.embedded ? "success" : "secondary"}>
                      {selected.embedded ? "embedded" : "text only"}
                    </Badge>
                  </div>
                  <h2>{selected.label}</h2>
                  <p>{selected.bodyPreview}</p>
                  <span>
                    confidence {selected.confidence.toFixed(2)} / importance{" "}
                    {selected.importance.toFixed(2)}
                  </span>
                </>
              ) : (
                <p className="row-subtext">knowledge nodeを選択してください。</p>
              )}
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}
