import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fetchGraphSnapshot, type GraphNode } from "../repositories/admin.repository";

const nodeColors: Record<GraphNode["kind"], string> = {
  knowledge: "#14b8a6",
  source: "#f59e0b",
  vibe_memory: "#60a5fa",
};

type PositionedNode = GraphNode & { x: number; y: number };

function layoutNodes(nodes: GraphNode[]): PositionedNode[] {
  if (nodes.length === 0) return [];
  const centerX = 380;
  const centerY = 210;
  const radius = 145;
  return nodes.map((node, index) => {
    const angle = (index / nodes.length) * Math.PI * 2 - Math.PI / 2;
    const laneOffset = node.kind === "knowledge" ? -28 : node.kind === "vibe_memory" ? 28 : 0;
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
  const graph = useQuery({
    queryKey: ["graph", 160],
    queryFn: () => fetchGraphSnapshot(160),
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const nodes = useMemo(() => layoutNodes(graph.data?.nodes ?? []), [graph.data?.nodes]);
  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const selected = selectedId ? nodeById.get(selectedId) : null;

  return (
    <div className="page-stack">
      <section className="page-heading">
        <div>
          <h1>Graph</h1>
          <p>Knowledge、Source、Vibe Memory を構造ノードとして眺めます。</p>
        </div>
      </section>

      <div className="graph-layout">
        <Card>
          <CardHeader>
            <CardTitle>Structure Map</CardTitle>
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
                        className="graph-edge"
                        strokeWidth={Math.max(1, edge.weight * 3)}
                      />
                    );
                  })}
                </g>
                <g>
                  {nodes.map((node) => (
                    <a
                      key={node.id}
                      className="graph-node"
                      href={`#${node.id}`}
                      aria-label={`select ${node.label}`}
                      onClick={(event) => {
                        event.preventDefault();
                        setSelectedId(node.id);
                      }}
                    >
                      <circle
                        cx={node.x}
                        cy={node.y}
                        r={12 + node.weight * 8}
                        fill={nodeColors[node.kind]}
                        opacity={selectedId === node.id ? 1 : 0.82}
                      />
                      <text x={node.x} y={node.y + 28} textAnchor="middle">
                        {truncate(node.label)}
                      </text>
                    </a>
                  ))}
                </g>
              </svg>
              {nodes.length === 0 ? (
                <div className="graph-empty">graph nodeはまだありません。</div>
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
                <span>Knowledge</span>
                <strong>{graph.data?.stats.knowledgeCount ?? 0}</strong>
              </div>
              <div>
                <span>Sources</span>
                <strong>{graph.data?.stats.sourceCount ?? 0}</strong>
              </div>
              <div>
                <span>Vibe Memory</span>
                <strong>{graph.data?.stats.vibeMemoryCount ?? 0}</strong>
              </div>
              <div>
                <span>Relations</span>
                <strong>{graph.data?.stats.relationCount ?? 0}</strong>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Selected</CardTitle>
            </CardHeader>
            <CardContent className="selected-node">
              {selected ? (
                <>
                  <Badge>{selected.kind}</Badge>
                  <h2>{selected.label}</h2>
                  <p>{selected.detail}</p>
                  <span>{selected.group}</span>
                </>
              ) : (
                <p className="row-subtext">nodeを選択してください。</p>
              )}
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}
