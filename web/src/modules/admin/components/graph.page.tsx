import { useMemo, useState, useRef, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
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

  return nodes.map((node, index) => {
    const ringIndex = Math.floor(index / 12);
    const ringPos = index % 12;
    const ringRadius = 200 + ringIndex * 150;
    const nodesInRing = Math.min(12, nodes.length - ringIndex * 12);
    const angle = (ringPos / nodesInRing) * Math.PI * 2 - Math.PI / 2;

    return {
      ...node,
      x: Math.cos(angle) * ringRadius,
      y: Math.sin(angle) * ringRadius,
    };
  });
}

export function GraphPage() {
  const [statusFilter, setStatusFilter] = useState<GraphStatusFilter>("current");
  const [edgeMode, setEdgeMode] = useState<GraphEdgeMode>("both");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1.2 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);

  const graph = useQuery({
    queryKey: ["graph", 300, statusFilter, edgeMode],
    queryFn: () =>
      fetchGraphSnapshot({
        limit: 300,
        status: statusFilter,
        edgeMode,
      }),
  });

  const nodes = useMemo(() => layoutNodes(graph.data?.nodes ?? []), [graph.data?.nodes]);
  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const selected = selectedId ? nodeById.get(selectedId) : null;
  const activeId = selectedId ?? hoveredId;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheelRaw = (e: WheelEvent) => {
      e.preventDefault();
      const delta = -e.deltaY;
      const factor = 1.1 ** (delta / 100);
      setTransform((prev) => ({
        ...prev,
        scale: Math.max(0.05, Math.min(5, prev.scale * factor)),
      }));
    };

    container.addEventListener("wheel", handleWheelRaw, { passive: false });
    return () => container.removeEventListener("wheel", handleWheelRaw);
  }, []);

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    setIsDragging(true);
    dragStart.current = { x: e.clientX - transform.x, y: e.clientY - transform.y };
  };

  const onMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return;
    setTransform((prev) => ({
      ...prev,
      x: e.clientX - dragStart.current.x,
      y: e.clientY - dragStart.current.y,
    }));
  };

  const onMouseUp = () => setIsDragging(false);

  return (
    <div className="graph-full-container" ref={containerRef}>
      <div className="graph-overlay-top-right">
        <div className="graph-controls-compact">
          <Select
            value={statusFilter}
            onChange={(event) => {
              setSelectedId(null);
              setStatusFilter(event.target.value as GraphStatusFilter);
            }}
            className="h-8 text-xs"
          >
            <option value="current">Current</option>
            <option value="active">Active</option>
            <option value="draft">Draft</option>
            <option value="deprecated">Deprecated</option>
            <option value="all">All Status</option>
          </Select>
          <Select
            value={edgeMode}
            onChange={(event) => {
              setSelectedId(null);
              setEdgeMode(event.target.value as GraphEdgeMode);
            }}
            className="h-8 text-xs"
          >
            <option value="both">Both Edges</option>
            <option value="semantic">Semantic</option>
            <option value="relations">Relations</option>
          </Select>
        </div>
      </div>

      <div className="graph-overlay-top-left">
        <div className="graph-title-block">
          <h1 className="text-xl font-bold text-white">Knowledge Graph</h1>
          <p className="mb-4 text-xs text-slate-400">
            蒸留されたKnowledgeの距離と明示relationを確認します。
          </p>
        </div>
        <div className="graph-legend-overlay">
          <div className="legend-item">
            <span className="legend-dot rule" />
            <span>Rule</span>
          </div>
          <div className="legend-item">
            <span className="legend-dot procedure" />
            <span>Procedure</span>
          </div>
        </div>
      </div>

      <div className="graph-overlay-bottom-right">
        <div className="graph-stats-overlay">
          <div className="stat-row">
            <span>Nodes</span>
            <strong>{graph.data?.stats.visibleKnowledgeCount ?? 0}</strong>
          </div>
          <div className="stat-row">
            <span>Edges</span>
            <strong>
              {(graph.data?.stats.semanticEdgeCount ?? 0) +
                (graph.data?.stats.relationEdgeCount ?? 0)}
            </strong>
          </div>
        </div>
      </div>

      <div className="graph-overlay-bottom-left">
        {selected ? (
          <div className="graph-selection-card">
            <div className="flex gap-2 mb-1">
              <Badge variant="secondary" className="h-4 text-[10px]">
                {selected.group}
              </Badge>
              <Badge variant="outline" className="h-4 border-slate-500 text-[10px] text-slate-100">
                {selected.status}
              </Badge>
            </div>
            <h3 className="text-sm font-bold truncate">{selected.label}</h3>
            <p className="text-xs text-muted-foreground line-clamp-2">{selected.bodyPreview}</p>
          </div>
        ) : (
          <div className="graph-selection-hint">Select a node to view details</div>
        )}
      </div>

      <div
        className="graph-canvas"
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
        style={{ cursor: isDragging ? "grabbing" : "grab" }}
      >
        <svg
          width="100%"
          height="100%"
          role="img"
          aria-label="Knowledge graph visualization"
          style={{ overflow: "visible" }}
        >
          <title>Knowledge graph visualization</title>
          <g
            transform={`translate(${transform.x + (containerRef.current?.clientWidth ?? 0) / 2}, ${transform.y + (containerRef.current?.clientHeight ?? 0) / 2}) scale(${transform.scale})`}
          >
            {/* Edges */}
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
                    strokeWidth={Math.max(0.5, edge.weight * 2)}
                    opacity={0.4}
                  />
                );
              })}
            </g>
            {/* Nodes: Circles First */}
            <g>
              {nodes.map((node) => {
                const isSelected = selectedId === node.id;
                return (
                  <circle
                    key={`circle-${node.id}`}
                    cx={node.x}
                    cy={node.y}
                    r={6 + node.weight * 4}
                    fill={nodeColors[node.group] ?? nodeColors.rule}
                    stroke={isSelected ? "#fff" : "transparent"}
                    strokeWidth={2}
                    className="graph-node-circle"
                    role="button"
                    tabIndex={0}
                    aria-label={`Select ${node.label || node.id}`}
                    onMouseEnter={() => setHoveredId(node.id)}
                    onMouseLeave={() => setHoveredId(null)}
                    onClick={() => setSelectedId(node.id)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      setSelectedId(node.id);
                    }}
                  />
                );
              })}
            </g>
            {/* Labels: Always on Top */}
            <g pointerEvents="none">
              {nodes.map((node) => {
                const active = activeId === node.id;
                return (
                  <text
                    key={`label-${node.id}`}
                    x={node.x}
                    y={node.y - (6 + node.weight * 4) - 10}
                    textAnchor="middle"
                    className={`graph-node-label ${active ? "active" : ""}`}
                  >
                    {node.label || node.id}
                  </text>
                );
              })}
            </g>
          </g>
        </svg>
        {nodes.length === 0 && !graph.isLoading ? (
          <div className="graph-empty-overlay">表示できるノードがありません</div>
        ) : null}
      </div>
    </div>
  );
}
