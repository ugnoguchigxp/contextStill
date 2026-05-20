import { useMemo, useState, useRef, useEffect, useLayoutEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Select } from "@/components/ui/select";
import {
  fetchGraphSnapshot,
  fetchGraphNodeDetail,
  type GraphEdge,
  type GraphRelationAxis,
  type GraphNode,
  type GraphNodeDetail,
  type GraphStatusFilter,
  type GraphViewMode,
} from "../repositories/admin.repository";

const nodeColors: Record<string, string> = {
  rule: "#14b8a6",
  procedure: "#60a5fa",
};

const LABEL_GAP_PX = 10;
const DETAIL_PANEL_GAP_PX = 16;
const DETAIL_PANEL_DEFAULT_TOP_PX = 148;
const MIN_GRAPH_SCALE = 0.1;
const MAX_GRAPH_SCALE = 24;

type PositionedNode = GraphNode & { x: number; y: number };
type Viewport = { width: number; height: number };
type Transform = { x: number; y: number; scale: number };
type EdgeLink = {
  sourceIndex: number;
  targetIndex: number;
  edgeKind: GraphEdge["edgeKind"];
  weight: number;
};
type ScreenPoint = { x: number; y: number };

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function createInitialPositions(nodes: GraphNode[]): PositionedNode[] {
  if (nodes.length === 0) return [];
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const spacing = 44;
  return nodes.map((node, index) => {
    const radius = Math.sqrt(index + 1) * spacing;
    const angle = index * goldenAngle - Math.PI / 2;
    return {
      ...node,
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
    };
  });
}

function layoutNodes(nodes: GraphNode[], edges: GraphEdge[]): PositionedNode[] {
  if (nodes.length === 0) return [];
  if (nodes.length === 1) {
    const [node] = nodes;
    if (!node) return [];
    return [{ ...node, x: 0, y: 0 }];
  }

  const positioned = createInitialPositions(nodes);
  const nodeIndexById = new Map(positioned.map((node, index) => [node.id, index]));
  const edgeLinks: EdgeLink[] = [];
  for (const edge of edges) {
    const sourceIndex = nodeIndexById.get(edge.source);
    const targetIndex = nodeIndexById.get(edge.target);
    if (sourceIndex === undefined || targetIndex === undefined || sourceIndex === targetIndex) {
      continue;
    }
    edgeLinks.push({
      sourceIndex,
      targetIndex,
      edgeKind: edge.edgeKind,
      weight: edge.weight,
    });
  }

  if (edgeLinks.length === 0) {
    return positioned;
  }

  const points = positioned.map((node) => ({ x: node.x, y: node.y, vx: 0, vy: 0 }));
  const forces = points.map(() => ({ x: 0, y: 0 }));
  const iterations =
    nodes.length >= 180 ? 100 : nodes.length >= 100 ? 110 : nodes.length >= 60 ? 130 : 170;
  const repulsionStrength = nodes.length >= 180 ? 150 : nodes.length >= 100 ? 1200 : 4000;
  const gravityStrength = nodes.length >= 180 ? 0.022 : nodes.length >= 100 ? 0.008 : 0.0022;
  const damping = 0.84;

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    for (let i = 0; i < forces.length; i += 1) {
      const force = forces[i];
      if (!force) continue;
      force.x = 0;
      force.y = 0;
    }

    for (let i = 0; i < points.length; i += 1) {
      const a = points[i];
      const fa = forces[i];
      if (!a || !fa) continue;
      for (let j = i + 1; j < points.length; j += 1) {
        const b = points[j];
        const fb = forces[j];
        if (!b || !fb) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distanceSq = dx * dx + dy * dy + 0.01;
        const distance = Math.sqrt(distanceSq);
        const strength = repulsionStrength / distanceSq;
        const fx = (dx / distance) * strength;
        const fy = (dy / distance) * strength;
        fa.x -= fx;
        fa.y -= fy;
        fb.x += fx;
        fb.y += fy;
      }
    }

    for (const edge of edgeLinks) {
      const source = points[edge.sourceIndex];
      const target = points[edge.targetIndex];
      const sourceForce = forces[edge.sourceIndex];
      const targetForce = forces[edge.targetIndex];
      if (!source || !target || !sourceForce || !targetForce) continue;
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const distance = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      const targetDistance =
        edge.edgeKind === "semantic"
          ? clamp(220 - edge.weight * 160, 70, 220)
          : edge.edgeKind === "session"
            ? clamp(200 - edge.weight * 120, 75, 210)
            : edge.edgeKind === "source"
              ? clamp(210 - edge.weight * 130, 80, 220)
              : clamp(230 - edge.weight * 120, 90, 240);
      const springStrength =
        edge.edgeKind === "semantic"
          ? 0.055
          : edge.edgeKind === "session"
            ? 0.04
            : edge.edgeKind === "source"
              ? 0.038
              : 0.03;
      const delta = distance - targetDistance;
      const fx = (dx / distance) * delta * springStrength;
      const fy = (dy / distance) * delta * springStrength;
      sourceForce.x += fx;
      sourceForce.y += fy;
      targetForce.x -= fx;
      targetForce.y -= fy;
    }

    for (let i = 0; i < points.length; i += 1) {
      const point = points[i];
      const force = forces[i];
      if (!point || !force) continue;
      force.x -= point.x * gravityStrength;
      force.y -= point.y * gravityStrength;
      point.vx = (point.vx + force.x) * damping;
      point.vy = (point.vy + force.y) * damping;
      point.x += point.vx;
      point.y += point.vy;
    }
  }

  const center = points.reduce((acc, point) => ({ x: acc.x + point.x, y: acc.y + point.y }), {
    x: 0,
    y: 0,
  });
  const centerX = center.x / points.length;
  const centerY = center.y / points.length;

  return positioned.map((node, index) => {
    const point = points[index];
    if (!point) return node;
    return {
      ...node,
      x: point.x - centerX,
      y: point.y - centerY,
    };
  });
}

function computeAutoFitTransform(nodes: PositionedNode[], viewport: Viewport): Transform {
  if (nodes.length === 0 || viewport.width <= 0 || viewport.height <= 0) {
    return { x: 0, y: 0, scale: 1 };
  }

  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const node of nodes) {
    const nodeRadius = 6 + node.weight * 4;
    const labelPadX = 64;
    const labelPadY = 28;
    minX = Math.min(minX, node.x - nodeRadius - labelPadX);
    maxX = Math.max(maxX, node.x + nodeRadius + labelPadX);
    minY = Math.min(minY, node.y - nodeRadius - labelPadY);
    maxY = Math.max(maxY, node.y + nodeRadius + labelPadY);
  }

  const graphWidth = Math.max(180, maxX - minX);
  const graphHeight = Math.max(180, maxY - minY);
  const horizontalPadding = viewport.width >= 1280 ? 180 : viewport.width >= 900 ? 130 : 80;
  const verticalPadding = viewport.height >= 820 ? 130 : 90;
  const availableWidth = Math.max(120, viewport.width - horizontalPadding * 2);
  const availableHeight = Math.max(120, viewport.height - verticalPadding * 2);
  const fitScale = Math.min(availableWidth / graphWidth, availableHeight / graphHeight);
  const scale = clamp(fitScale, 0.05, 1.6);

  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  return {
    x: -centerX * scale,
    y: -centerY * scale,
    scale,
  };
}

function toScreenPoint(
  node: PositionedNode,
  transform: Transform,
  viewport: Viewport,
): ScreenPoint {
  return {
    x: transform.x + viewport.width / 2 + node.x * transform.scale,
    y: transform.y + viewport.height / 2 + node.y * transform.scale,
  };
}

export function GraphPage() {
  const [statusFilter, setStatusFilter] = useState<GraphStatusFilter>("current");
  const [viewMode, setViewMode] = useState<GraphViewMode>("relation");
  const [relationAxes, setRelationAxes] = useState<GraphRelationAxis[]>([
    "session",
    "project",
    "source",
  ]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const [transform, setTransform] = useState<Transform>({ x: 0, y: 0, scale: 1 });
  const [viewport, setViewport] = useState<Viewport>({ width: 0, height: 0 });
  const [detailPanelTop, setDetailPanelTop] = useState(DETAIL_PANEL_DEFAULT_TOP_PX);
  const [hasInteracted, setHasInteracted] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);

  const graph = useQuery({
    queryKey: ["graph", 1000, statusFilter, viewMode, relationAxes.join(",")],
    queryFn: () =>
      fetchGraphSnapshot({
        limit: 1000,
        status: statusFilter,
        view: viewMode,
        relationAxes: viewMode === "relation" ? relationAxes : undefined,
      }),
  });

  // ノードクリック時に詳細を取得
  const selectedRawId = selectedId ? selectedId.replace(/^knowledge:/, "") : null;
  const nodeDetail = useQuery<GraphNodeDetail | null>({
    queryKey: ["graph-node-detail", selectedRawId],
    queryFn: () => (selectedRawId ? fetchGraphNodeDetail(selectedRawId) : Promise.resolve(null)),
    enabled: Boolean(selectedRawId),
    staleTime: 60_000,
  });

  const nodes = useMemo(
    () => layoutNodes(graph.data?.nodes ?? [], graph.data?.edges ?? []),
    [graph.data?.nodes, graph.data?.edges],
  );
  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const screenNodeById = useMemo(
    () => new Map(nodes.map((node) => [node.id, toScreenPoint(node, transform, viewport)])),
    [nodes, transform, viewport],
  );
  const selectedNode = selectedId ? nodeById.get(selectedId) : undefined;
  const activeId = selectedId ?? hoveredId;
  const totalEdges = graph.data?.edges.length ?? 0;

  const toggleRelationAxis = (axis: GraphRelationAxis) => {
    setSelectedId(null);
    setHoveredId(null);
    setHasInteracted(false);
    setRelationAxes((prev) => {
      const hasAxis = prev.includes(axis);
      if (hasAxis) {
        if (prev.length === 1) return prev;
        return prev.filter((candidate) => candidate !== axis);
      }
      const next = [...prev, axis];
      const axisOrder: Record<GraphRelationAxis, number> = { session: 0, project: 1, source: 2 };
      return next.sort((a, b) => (axisOrder[a] ?? 0) - (axisOrder[b] ?? 0));
    });
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const updateViewport = () =>
      setViewport({
        width: container.clientWidth,
        height: container.clientHeight,
      });

    updateViewport();
    const observer =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(updateViewport) : undefined;
    observer?.observe(container);
    window.addEventListener("resize", updateViewport);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updateViewport);
    };
  }, []);

  useEffect(() => {
    if (hasInteracted) return;
    if (nodes.length === 0) return;
    setTransform(computeAutoFitTransform(nodes, viewport));
  }, [nodes, viewport, hasInteracted]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const controls = controlsRef.current;
    if (!container || !controls) return;

    const updatePanelTop = () => {
      const containerRect = container.getBoundingClientRect();
      const controlsRect = controls.getBoundingClientRect();
      setDetailPanelTop(Math.ceil(controlsRect.bottom - containerRect.top + DETAIL_PANEL_GAP_PX));
    };

    updatePanelTop();
    const observer =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(updatePanelTop) : undefined;
    observer?.observe(container);
    observer?.observe(controls);
    window.addEventListener("resize", updatePanelTop);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updatePanelTop);
    };
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheelRaw = (e: WheelEvent) => {
      e.preventDefault();
      const delta = -e.deltaY;
      const factor = 1.1 ** (delta / 100);
      const rect = container.getBoundingClientRect();
      const pointerX = e.clientX - rect.left - rect.width / 2;
      const pointerY = e.clientY - rect.top - rect.height / 2;
      setHasInteracted(true);
      setTransform((prev) => {
        const nextScale = clamp(prev.scale * factor, MIN_GRAPH_SCALE, MAX_GRAPH_SCALE);
        const scaleRatio = nextScale / prev.scale;
        return {
          x: pointerX - (pointerX - prev.x) * scaleRatio,
          y: pointerY - (pointerY - prev.y) * scaleRatio,
          scale: nextScale,
        };
      });
    };

    container.addEventListener("wheel", handleWheelRaw, { passive: false });
    return () => container.removeEventListener("wheel", handleWheelRaw);
  }, []);

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    setHasInteracted(true);
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
      <div className="graph-overlay-top-right" ref={controlsRef}>
        <div className="graph-controls-compact">
          <Select
            value={statusFilter}
            onChange={(event) => {
              setSelectedId(null);
              setHoveredId(null);
              setHasInteracted(false);
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
            value={viewMode}
            onChange={(event) => {
              setSelectedId(null);
              setHoveredId(null);
              setHasInteracted(false);
              setViewMode(event.target.value as GraphViewMode);
            }}
            className="h-8 text-xs"
          >
            <option value="relation">Relation</option>
            <option value="semantic">Semantic</option>
          </Select>
          {viewMode === "relation" ? (
            <div className="graph-axis-toggles">
              <label htmlFor="graph-axis-session" className="graph-axis-toggle">
                <Checkbox
                  id="graph-axis-session"
                  checked={relationAxes.includes("session")}
                  onChange={() => toggleRelationAxis("session")}
                />
                <span className="graph-axis-label session">Session</span>
              </label>
              <label htmlFor="graph-axis-project" className="graph-axis-toggle">
                <Checkbox
                  id="graph-axis-project"
                  checked={relationAxes.includes("project")}
                  onChange={() => toggleRelationAxis("project")}
                />
                <span className="graph-axis-label project">Project</span>
              </label>
              <label htmlFor="graph-axis-source" className="graph-axis-toggle">
                <Checkbox
                  id="graph-axis-source"
                  checked={relationAxes.includes("source")}
                  onChange={() => toggleRelationAxis("source")}
                />
                <span className="graph-axis-label source">Source</span>
              </label>
            </div>
          ) : null}
        </div>
      </div>

      <div className="graph-overlay-top-left">
        <div className="graph-title-block">
          <h1 className="text-xl font-bold text-white">Knowledge Graph</h1>
          <p className="mb-4 text-xs text-slate-400">
            Semantic と Relation（Project / Session）を切り替えて確認します。
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
          <div className="legend-item">
            <span className="legend-line project" />
            <span>Project Relation</span>
          </div>
          <div className="legend-item">
            <span className="legend-line session" />
            <span>Session Relation</span>
          </div>
          <div className="legend-item">
            <span className="legend-line source" />
            <span>Source Relation</span>
          </div>
          <div className="legend-item">
            <span className="legend-line semantic" />
            <span>Semantic Edge</span>
          </div>
          <p className="graph-legend-note">
            {viewMode === "semantic"
              ? "semantic: cosine 類似度（minSimilarity=0.72, topK=3）"
              : "relation: session/project 軸を同時に表示できます"}
          </p>
        </div>
      </div>

      <div className="graph-overlay-stats">
        <div className="graph-stats-overlay">
          <div className="stat-row">
            <span>Nodes</span>
            <strong>{graph.data?.stats.visibleKnowledgeCount ?? 0}</strong>
          </div>
          <div className="stat-row">
            <span>Edges</span>
            <strong>{totalEdges}</strong>
          </div>
          <div className="stat-row">
            <span>Embedded</span>
            <strong>{graph.data?.stats.embeddedKnowledgeCount ?? 0}</strong>
          </div>
          {viewMode === "semantic" ? (
            <div className="stat-row graph-stats-subtle">
              <span>Semantic</span>
              <strong>{graph.data?.stats.semanticEdgeCount ?? 0}</strong>
            </div>
          ) : (
            <>
              <div className="stat-row graph-stats-subtle">
                <span>Session</span>
                <strong>{graph.data?.stats.sessionEdgeCount ?? 0}</strong>
              </div>
              <div className="stat-row graph-stats-subtle">
                <span>Project</span>
                <strong>{graph.data?.stats.projectEdgeCount ?? 0}</strong>
              </div>
              <div className="stat-row graph-stats-subtle">
                <span>Source</span>
                <strong>{graph.data?.stats.sourceEdgeCount ?? 0}</strong>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="graph-overlay-right-detail" style={{ top: detailPanelTop }}>
        <aside className="graph-detail-panel" aria-live="polite">
          <div className="graph-detail-panel-header">
            <span className="graph-detail-kicker">Node Detail</span>
            <strong>{viewMode === "semantic" ? "Semantic" : "Relation"}</strong>
          </div>
          {selectedId ? (
            nodeDetail.isLoading ? (
              <div className="graph-detail-empty">Loading node detail...</div>
            ) : nodeDetail.data ? (
              <>
                <div className="graph-detail-badges">
                  <Badge variant="secondary" className="h-5 text-[11px]">
                    {nodeDetail.data.group}
                  </Badge>
                  <Badge
                    variant="outline"
                    className="h-5 border-slate-400 text-[11px] text-slate-50"
                  >
                    {nodeDetail.data.status}
                  </Badge>
                  <Badge
                    variant={selectedNode?.embedded ? "secondary" : "outline"}
                    className={`h-5 text-[11px] ${
                      selectedNode?.embedded ? "" : "border-amber-300 text-amber-100"
                    }`}
                  >
                    {selectedNode?.embedded ? "embedded" : "no-embedding"}
                  </Badge>
                </div>
                <h2 className="graph-detail-title">{nodeDetail.data.label}</h2>
                <div className="graph-detail-meta-grid">
                  <div className="graph-detail-metric">
                    <span>Confidence</span>
                    <strong>{nodeDetail.data.confidence.toFixed(0)}</strong>
                  </div>
                  <div className="graph-detail-metric">
                    <span>Importance</span>
                    <strong>{nodeDetail.data.importance.toFixed(0)}</strong>
                  </div>
                  <div className="graph-detail-metric">
                    <span>Weight</span>
                    <strong>{nodeDetail.data.weight.toFixed(2)}</strong>
                  </div>
                  <div className="graph-detail-metric">
                    <span>Kind</span>
                    <strong>{nodeDetail.data.kind}</strong>
                  </div>
                </div>
                <div className="graph-detail-body">
                  <span>Preview</span>
                  <p>{nodeDetail.data.bodyPreview}</p>
                </div>
                <div className="graph-detail-id">{selectedId}</div>
              </>
            ) : selectedNode ? (
              <>
                <div className="graph-detail-badges">
                  <Badge variant="secondary" className="h-5 text-[11px]">
                    {selectedNode.group}
                  </Badge>
                  <Badge
                    variant="outline"
                    className="h-5 border-slate-400 text-[11px] text-slate-50"
                  >
                    {selectedNode.status}
                  </Badge>
                </div>
                <h2 className="graph-detail-title">{selectedNode.label}</h2>
                <div className="graph-detail-empty">Detail fetch failed. Showing graph data.</div>
              </>
            ) : null
          ) : (
            <div className="graph-detail-empty">Select a node to view details</div>
          )}
        </aside>
      </div>

      <div
        className="graph-canvas"
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
        onDoubleClick={() => {
          setHasInteracted(false);
          setTransform(computeAutoFitTransform(nodes, viewport));
        }}
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
          {/* Edges */}
          <g>
            {graph.data?.edges.map((edge) => {
              const source = screenNodeById.get(edge.source);
              const target = screenNodeById.get(edge.target);
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
              const isEmbedded = node.embedded;
              const screenNode = screenNodeById.get(node.id);
              if (!screenNode) return null;
              return (
                <circle
                  key={`circle-${node.id}`}
                  cx={screenNode.x}
                  cy={screenNode.y}
                  r={6 + node.weight * 4}
                  fill={nodeColors[node.group] ?? nodeColors.rule}
                  stroke={
                    isSelected
                      ? "#fff"
                      : isEmbedded
                        ? "rgba(255, 255, 255, 0.12)"
                        : "rgba(251, 191, 36, 0.88)"
                  }
                  strokeWidth={isSelected ? 2.2 : isEmbedded ? 0.8 : 1.2}
                  strokeDasharray={isEmbedded ? undefined : "2.5 2"}
                  opacity={isEmbedded ? 1 : 0.9}
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
              const nodeRadius = 6 + node.weight * 4;
              const screenNode = screenNodeById.get(node.id);
              if (!screenNode) return null;
              return (
                <text
                  key={`label-${node.id}`}
                  x={screenNode.x}
                  y={screenNode.y - nodeRadius - LABEL_GAP_PX}
                  textAnchor="middle"
                  className={`graph-node-label ${active ? "active" : ""}`}
                >
                  {node.label || node.id}
                </text>
              );
            })}
          </g>
        </svg>
        {nodes.length === 0 && !graph.isLoading ? (
          <div className="graph-empty-overlay">表示できるノードがありません</div>
        ) : null}
      </div>
    </div>
  );
}
