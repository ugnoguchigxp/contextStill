import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  type GraphCommunityDisplayMode,
  type GraphCommunitySummary,
  type GraphEdge,
  type GraphNode,
  type GraphNodeDetail,
  type GraphRelationAxis,
  type GraphStatusFilter,
  type GraphSuperedge,
  type GraphSupernode,
  type GraphViewMode,
  type LandscapeCommunity,
  type LandscapeContradictionOverlayItem,
  type LandscapeReplayComparisonRun,
  type LandscapeReviewItem,
  type LandscapeTrajectoryCandidate,
  createLandscapeReviewCandidates,
  fetchGraphNodeDetail,
  fetchGraphSnapshot,
  fetchLandscapeContradictionOverlay,
  fetchLandscapeReplayComparison,
  fetchLandscapeReplaySnapshot,
  fetchLandscapeReviewItems,
  fetchLandscapeSnapshot,
  fetchLandscapeSnapshotCacheStatus,
  fetchLandscapeTrajectory,
  materializeLandscapeReviewItems,
  updateGraphCommunityLabel,
  updateLandscapeReviewItemStatus,
} from "../repositories/admin.repository";
import { ContradictionReviewList } from "./contradiction-review-list";
import {
  SandboxComparisonPanel,
  type SandboxDiffFilter,
  sandboxChangedKnowledgeIds,
} from "./sandbox-comparison-panel";
import { TrajectoryPanel, type TrajectoryStageFilter } from "./trajectory-panel";

const nodeColors: Record<string, string> = {
  rule: "#14b8a6",
  procedure: "#60a5fa",
  source: "#22d3ee",
};

const communityPalette = [
  "#22d3ee",
  "#f97316",
  "#84cc16",
  "#e879f9",
  "#facc15",
  "#38bdf8",
  "#fb7185",
  "#a78bfa",
  "#34d399",
  "#f59e0b",
];

const LABEL_GAP_PX = 10;
const DETAIL_PANEL_GAP_PX = 16;
const DETAIL_PANEL_DEFAULT_TOP_PX = 148;
const MIN_GRAPH_SCALE = 0.1;
const MAX_GRAPH_SCALE = 24;

type PositionedNode = GraphNode & { x: number; y: number };
type Viewport = { width: number; height: number };
type Transform = { x: number; y: number; scale: number };
type DisplayEdgeKind = GraphEdge["edgeKind"] | "community";
type DisplayNode = {
  id: string;
  label: string;
  kind: GraphNode["kind"] | "community";
  weight: number;
  group: string;
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
  isSupernode: boolean;
  healthDead?: boolean;
  healthStale?: boolean;
  healthThinEvidence?: boolean;
};
type PositionedDisplayNode = DisplayNode & { x: number; y: number };
type EdgeLink = {
  sourceIndex: number;
  targetIndex: number;
  edgeKind: DisplayEdgeKind;
  weight: number;
};
type ScreenPoint = { x: number; y: number };

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function nodeColorForView(node: DisplayNode, viewMode: GraphViewMode): string {
  if (node.kind === "source") {
    return nodeColors.source;
  }

  if (viewMode !== "community") {
    return nodeColors[node.group] ?? nodeColors.rule;
  }

  const rank = node.communityRank;
  if (!rank || rank <= 0) return "#94a3b8";
  if (rank <= communityPalette.length) {
    const color = communityPalette[rank - 1];
    if (color) return color;
  }

  const hue = (rank * 47) % 360;
  return `hsl(${hue}, 72%, 58%)`;
}

function buildSupernodeDisplayNodes(supernodes: GraphSupernode[]): DisplayNode[] {
  return supernodes.map((supernode) => ({
    id: supernode.id,
    label: supernode.label,
    kind: "community",
    weight: clamp(0.35 + Math.log2(supernode.size + 1) * 0.24, 0.35, 2.2),
    group: "rule",
    status: "active",
    embedded: true,
    communityId: supernode.id,
    communityRank: supernode.communityRank,
    communitySize: supernode.size,
    communityKey: supernode.communityKey,
    communityLabel: supernode.label,
    isSupernode: true,
    healthDead: supernode.health.dead,
    healthStale: supernode.health.stale,
    healthThinEvidence: supernode.health.thinEvidence,
  }));
}

function asDisplayEdgesFromSuperedges(superedges: GraphSuperedge[]): Array<{
  id: string;
  source: string;
  target: string;
  edgeKind: DisplayEdgeKind;
  weight: number;
}> {
  return superedges.map((edge, index) => ({
    id: `${edge.id}:${index}`,
    source: edge.source,
    target: edge.target,
    edgeKind: "community",
    weight: edge.weight,
  }));
}

function sourceNodeHalfSize(node: DisplayNode): { x: number; y: number } {
  return {
    x: clamp(14 + node.weight * 8, 14, 30),
    y: clamp(8 + node.weight * 4, 8, 15),
  };
}

function createInitialPositions(nodes: DisplayNode[]): PositionedDisplayNode[] {
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

function layoutNodes(
  nodes: DisplayNode[],
  edges: Array<{ source: string; target: string; edgeKind: DisplayEdgeKind; weight: number }>,
): PositionedDisplayNode[] {
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
              : edge.edgeKind === "community"
                ? clamp(250 - edge.weight * 18, 130, 280)
                : clamp(230 - edge.weight * 120, 90, 240);
      const springStrength =
        edge.edgeKind === "semantic"
          ? 0.055
          : edge.edgeKind === "session"
            ? 0.04
            : edge.edgeKind === "source"
              ? 0.038
              : edge.edgeKind === "community"
                ? 0.03
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

function computeAutoFitTransform(nodes: PositionedDisplayNode[], viewport: Viewport): Transform {
  if (nodes.length === 0 || viewport.width <= 0 || viewport.height <= 0) {
    return { x: 0, y: 0, scale: 1 };
  }

  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const node of nodes) {
    const nodeRadius = 6 + node.weight * 4;
    const halfSize =
      node.kind === "source" ? sourceNodeHalfSize(node) : { x: nodeRadius, y: nodeRadius };
    const labelPadX = 64;
    const labelPadY = 28;
    minX = Math.min(minX, node.x - halfSize.x - labelPadX);
    maxX = Math.max(maxX, node.x + halfSize.x + labelPadX);
    minY = Math.min(minY, node.y - halfSize.y - labelPadY);
    maxY = Math.max(maxY, node.y + halfSize.y + labelPadY);
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
  node: PositionedDisplayNode,
  transform: Transform,
  viewport: Viewport,
): ScreenPoint {
  return {
    x: transform.x + viewport.width / 2 + node.x * transform.scale,
    y: transform.y + viewport.height / 2 + node.y * transform.scale,
  };
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function landscapeSnapshotCacheTypeLabel(value: string): string {
  if (value === "landscape_snapshot") return "snapshot";
  if (value === "landscape_replay_snapshot") return "replay";
  if (value === "landscape_replay_comparison") return "compare";
  return value;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} MB`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)} KB`;
  return `${Math.trunc(value)} B`;
}

function healthLabel(summary: GraphCommunitySummary): string {
  if (summary.health.dead) return "cold";
  if (summary.health.stale || summary.health.thinEvidence) return "warm";
  return "hot";
}

function landscapePrimaryLabel(value: LandscapeCommunity["classification"]["primary"]): string {
  switch (value) {
    case "strong_attractor":
      return "Strong Attractor";
    case "useful_attractor":
      return "Useful Attractor";
    case "negative_attractor_candidate":
      return "Negative Candidate";
    case "over_selected_not_used":
      return "Over-selected Not-used";
    case "dead_zone_reachability_risk":
      return "Dead Zone (Reachability Risk)";
    case "dead_zone_stale":
      return "Dead Zone (Stale)";
    case "feedback_insufficient":
      return "Feedback Insufficient";
    default:
      return "Neutral";
  }
}

function landscapeConfidenceLabel(
  value: LandscapeCommunity["feedback"]["feedbackConfidence"],
): string {
  if (value === "high") return "High";
  if (value === "medium") return "Medium";
  if (value === "low") return "Low";
  return "Insufficient";
}

function communityComparisonLabel(
  value:
    | "aligned"
    | "semantic_split"
    | "semantic_merge"
    | "relation_orphan"
    | "semantic_reachable_dead_zone",
): string {
  switch (value) {
    case "semantic_reachable_dead_zone":
      return "Semantic Reachable Dead Zone";
    case "semantic_split":
      return "Semantic Split";
    case "semantic_merge":
      return "Semantic Merge";
    case "relation_orphan":
      return "Relation Orphan";
    default:
      return "Aligned";
  }
}

function replayComparisonLabel(value: LandscapeReplayComparisonRun["comparison"]): string {
  switch (value) {
    case "lost_baseline":
      return "Lost Baseline";
    case "new_only":
      return "New Only";
    case "no_current_match":
      return "No Current Match";
    case "drifted":
      return "Drifted";
    default:
      return "Stable";
  }
}

function reviewItemReasonLabel(value: LandscapeReviewItem["reason"]): string {
  switch (value) {
    case "used_baseline_lost":
      return "Used Lost";
    case "baseline_off_topic":
      return "Off Topic";
    case "baseline_wrong":
      return "Wrong";
    case "baseline_missing_after_recompile":
      return "Missing";
    case "negative_attractor_candidate":
      return "Negative Candidate";
    case "wrong_review_required":
      return "Wrong Review Required";
    case "over_selected_not_used":
      return "Over-selected Not-used";
    case "dead_zone_reachability_risk":
      return "Dead Zone Reachability";
    case "dead_zone_stale":
      return "Dead Zone Stale";
    case "semantic_reachable_dead_zone":
      return "Semantic Reachable Dead Zone";
    case "semantic_split":
      return "Semantic Split";
    case "semantic_merge":
      return "Semantic Merge";
    case "relation_orphan":
      return "Relation Orphan";
    case "promotion_gate_review":
      return "Promotion Gate Review";
    case "contradiction_review":
      return "Contradiction Review";
    default:
      return value;
  }
}

function reviewItemActionLabel(value: LandscapeReviewItem["proposedAction"]): string {
  switch (value) {
    case "review_only":
      return "Review only";
    case "refine_applies_to":
      return "Refine appliesTo";
    case "repair_reachability":
      return "Repair reachability";
    case "review_wrong":
      return "Review wrong";
    case "split_or_merge_review":
      return "Split / Merge review";
    case "promotion_gate_review":
      return "Promotion gate review";
    case "demote_to_draft_candidate":
      return "Demote to draft candidate";
    case "review_contradiction":
      return "Review contradiction";
    default:
      return value;
  }
}

function reviewItemNeedsPromotionGateWarning(item: LandscapeReviewItem): boolean {
  return item.reason === "promotion_gate_review";
}

function reviewItemWarningSummary(item: LandscapeReviewItem): string {
  const evidence = item.evidence.slice(0, 2).join(" / ");
  if (evidence) return evidence;
  return "manual review is required before promotion";
}

function reviewConfidenceRank(value: LandscapeReviewItem["confidence"]): number {
  if (value === "high") return 3;
  if (value === "medium") return 2;
  return 1;
}

function nodeLandscapeClass(
  node: DisplayNode,
  viewMode: GraphViewMode,
  landscapeByCommunityKey: Map<string, LandscapeCommunity>,
  trajectoryHighlightKnowledgeIds: Set<string>,
  sandboxHighlightCommunityKeys: Set<string>,
): string[] {
  if (viewMode !== "community" || !node.communityKey) return [];
  const landscape = landscapeByCommunityKey.get(node.communityKey);
  const classes: string[] = [];
  if (landscape) {
    if (landscape.classification.primary === "strong_attractor") {
      classes.push("landscape-strong-attractor");
    } else if (landscape.classification.primary === "negative_attractor_candidate") {
      classes.push("landscape-negative-attractor");
    } else if (
      landscape.classification.primary === "dead_zone_reachability_risk" ||
      landscape.classification.primary === "dead_zone_stale"
    ) {
      classes.push("landscape-dead-zone");
    } else if (landscape.classification.primary === "over_selected_not_used") {
      classes.push("landscape-over-selected");
    } else if (landscape.classification.primary === "feedback_insufficient") {
      classes.push("landscape-feedback-insufficient");
    }
  }
  const knowledgeId = node.id.startsWith("knowledge:") ? node.id.replace(/^knowledge:/, "") : null;
  if (knowledgeId && trajectoryHighlightKnowledgeIds.has(knowledgeId)) {
    classes.push("landscape-trajectory-highlight");
  }
  if (sandboxHighlightCommunityKeys.has(node.communityKey)) {
    classes.push("landscape-sandbox-affected");
  }

  return classes;
}

function matchesTrajectoryStage(
  candidate: LandscapeTrajectoryCandidate,
  stage: TrajectoryStageFilter,
): boolean {
  switch (stage) {
    case "text":
      return candidate.textRank !== null;
    case "vector":
      return candidate.vectorRank !== null;
    case "merged":
      return candidate.mergedRank !== null;
    case "final":
      return candidate.finalRank !== null;
    case "selected":
      return candidate.selected;
    case "suppressed":
      return candidate.suppressed;
    default:
      return true;
  }
}

export function GraphPage() {
  const [statusFilter, setStatusFilter] = useState<GraphStatusFilter>("current");
  const [viewMode, setViewMode] = useState<GraphViewMode>("relation");
  const [communityDisplayMode, setCommunityDisplayMode] =
    useState<GraphCommunityDisplayMode>("detail");
  const [relationAxes, setRelationAxes] = useState<GraphRelationAxis[]>([
    "session",
    "project",
    "source",
  ]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [communityLabelDraft, setCommunityLabelDraft] = useState("");
  const [selectedTrajectoryRunId, setSelectedTrajectoryRunId] = useState<string | null>(null);
  const [selectedTrajectoryStage, setSelectedTrajectoryStage] =
    useState<TrajectoryStageFilter>("all");
  const [selectedSandboxRunId, setSelectedSandboxRunId] = useState<string | null>(null);
  const [sandboxDiffFilter, setSandboxDiffFilter] = useState<SandboxDiffFilter>("all");
  const [showContradictionOverlay, setShowContradictionOverlay] = useState(false);
  const [contradictionStatus, setContradictionStatus] = useState<
    "pending" | "reviewing" | "resolved" | "dismissed" | "all"
  >("pending");
  const [contradictionConfidenceMin, setContradictionConfidenceMin] = useState(0.62);
  const [contradictionQueueConfidence, setContradictionQueueConfidence] = useState<
    "all" | "medium" | "high"
  >("all");

  const [transform, setTransform] = useState<Transform>({ x: 0, y: 0, scale: 1 });
  const [viewport, setViewport] = useState<Viewport>({ width: 0, height: 0 });
  const [detailPanelTop, setDetailPanelTop] = useState(DETAIL_PANEL_DEFAULT_TOP_PX);
  const [hasInteracted, setHasInteracted] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const dragged = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  const graph = useQuery({
    queryKey: ["graph", 1000, statusFilter, viewMode, communityDisplayMode, relationAxes.join(",")],
    queryFn: () =>
      fetchGraphSnapshot({
        limit: 1000,
        status: statusFilter,
        view: viewMode,
        communityDisplay: viewMode === "community" ? communityDisplayMode : undefined,
        relationAxes:
          viewMode === "relation" || viewMode === "community" ? relationAxes : undefined,
        sourceNodeLimit: viewMode === "evidence" ? 800 : undefined,
      }),
  });

  const landscape = useQuery({
    queryKey: ["graph-landscape", 30, 1000, statusFilter, relationAxes.join(",")],
    queryFn: () =>
      fetchLandscapeSnapshot({
        windowDays: 30,
        limit: 1000,
        status: statusFilter,
        relationAxes,
      }),
    enabled: viewMode === "community",
    staleTime: 60_000,
  });

  const landscapeSnapshotCacheStatus = useQuery({
    queryKey: ["graph-landscape-cache-status"],
    queryFn: () => fetchLandscapeSnapshotCacheStatus(),
    enabled: viewMode === "community",
    staleTime: 30_000,
  });

  const landscapeReplay = useQuery({
    queryKey: ["graph-landscape-replay", 30, 500, 1000, statusFilter, relationAxes.join(",")],
    queryFn: () =>
      fetchLandscapeReplaySnapshot({
        windowDays: 30,
        limit: 500,
        landscapeLimit: 1000,
        landscapeStatus: statusFilter,
        relationAxes,
        includeRuns: false,
      }),
    enabled: viewMode === "community",
    staleTime: 60_000,
  });

  const landscapeReplayComparison = useQuery({
    queryKey: ["graph-landscape-replay-compare", 30, 25, 12],
    queryFn: () =>
      fetchLandscapeReplayComparison({
        windowDays: 30,
        limit: 25,
        runStatus: "all",
        currentLimit: 12,
        includeRuns: true,
      }),
    enabled: viewMode === "community",
    staleTime: 60_000,
  });

  const landscapeReviewItems = useQuery({
    queryKey: ["graph-landscape-review-items", "pending"],
    queryFn: () =>
      fetchLandscapeReviewItems({
        status: "pending",
        source: "all",
        reason: "all",
        proposedAction: "all",
        priorityMin: 0,
        limit: 200,
      }),
    enabled: viewMode === "community",
    staleTime: 30_000,
  });

  const landscapeContradictions = useQuery({
    queryKey: [
      "graph-landscape-contradictions",
      contradictionStatus,
      contradictionConfidenceMin,
      80,
    ],
    queryFn: () =>
      fetchLandscapeContradictionOverlay({
        status: contradictionStatus,
        confidenceMin: contradictionConfidenceMin,
        limit: 80,
      }),
    enabled: viewMode === "community" && showContradictionOverlay,
    staleTime: 30_000,
  });

  const landscapeTrajectory = useQuery({
    queryKey: ["graph-landscape-trajectory", selectedTrajectoryRunId, 200],
    queryFn: () =>
      selectedTrajectoryRunId
        ? fetchLandscapeTrajectory({
            runId: selectedTrajectoryRunId,
            includeCandidates: true,
            limit: 200,
          })
        : Promise.resolve(null),
    enabled: viewMode === "community" && Boolean(selectedTrajectoryRunId),
    staleTime: 30_000,
  });

  // ノードクリック時に詳細を取得
  const selectedRawId = selectedId?.startsWith("knowledge:")
    ? selectedId.replace(/^knowledge:/, "")
    : null;
  const nodeDetail = useQuery<GraphNodeDetail | null>({
    queryKey: ["graph-node-detail", selectedRawId],
    queryFn: () => (selectedRawId ? fetchGraphNodeDetail(selectedRawId) : Promise.resolve(null)),
    enabled: Boolean(selectedRawId),
    staleTime: 60_000,
  });

  const inCommunitySupernodeMode = viewMode === "community" && communityDisplayMode === "supernode";

  const displayNodesSource = useMemo<DisplayNode[]>(() => {
    if (inCommunitySupernodeMode) {
      return buildSupernodeDisplayNodes(graph.data?.supernodes ?? []);
    }
    return (graph.data?.nodes ?? []).map((node) => ({
      ...node,
      isSupernode: false,
    }));
  }, [graph.data?.nodes, graph.data?.supernodes, inCommunitySupernodeMode]);

  const displayEdgesSource = useMemo<
    Array<{ id: string; source: string; target: string; edgeKind: DisplayEdgeKind; weight: number }>
  >(() => {
    if (inCommunitySupernodeMode) {
      return asDisplayEdgesFromSuperedges(graph.data?.superedges ?? []);
    }
    return (graph.data?.edges ?? []).map((edge, index) => ({
      id: `${edge.id}:${index}`,
      source: edge.source,
      target: edge.target,
      edgeKind: edge.edgeKind,
      weight: edge.weight,
    }));
  }, [graph.data?.edges, graph.data?.superedges, inCommunitySupernodeMode]);

  const nodes = useMemo(
    () => layoutNodes(displayNodesSource, displayEdgesSource),
    [displayNodesSource, displayEdgesSource],
  );
  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const screenNodeById = useMemo(
    () => new Map(nodes.map((node) => [node.id, toScreenPoint(node, transform, viewport)])),
    [nodes, transform, viewport],
  );
  const selectedNode = selectedId ? nodeById.get(selectedId) : undefined;
  const selectedCommunityId =
    selectedNode?.communityId ?? (selectedId?.startsWith("community:") ? selectedId : undefined);
  const communities = graph.data?.communities ?? [];
  const selectedCommunity =
    (selectedCommunityId
      ? communities.find((community) => community.communityId === selectedCommunityId)
      : undefined) ?? communities[0];
  const landscapeByCommunityKey = useMemo(
    () =>
      new Map(
        (landscape.data?.communities ?? []).map((community) => [community.communityKey, community]),
      ),
    [landscape.data?.communities],
  );
  const selectedLandscapeCommunity = selectedCommunity?.communityKey
    ? landscapeByCommunityKey.get(selectedCommunity.communityKey)
    : undefined;
  const selectedReplayCommunity = selectedCommunity?.communityKey
    ? landscapeReplay.data?.communityReplaySummaries.find(
        (community) => community.communityKey === selectedCommunity.communityKey,
      )
    : undefined;
  const selectedCommunityComparison = selectedCommunity?.communityKey
    ? landscapeReplay.data?.communityComparison.communities.find(
        (community) => community.relationCommunityKey === selectedCommunity.communityKey,
      )
    : undefined;
  const topReplayFacetRisks = useMemo(
    () =>
      (landscapeReplay.data?.facetSummaries ?? [])
        .filter(
          (facet) =>
            facet.negativeCandidateHitCount + facet.overSelectedHitCount + facet.deadZoneMissCount >
            0,
        )
        .slice(0, 3),
    [landscapeReplay.data?.facetSummaries],
  );
  const replayReviewCandidateQueue = useMemo(
    () => (landscapeReplayComparison.data?.appliesToRefineCandidates ?? []).slice(0, 6),
    [landscapeReplayComparison.data?.appliesToRefineCandidates],
  );
  const persistedPendingReviewItems = useMemo(
    () => landscapeReviewItems.data?.items ?? [],
    [landscapeReviewItems.data?.items],
  );
  const contradictionPendingReviewItems = useMemo(
    () =>
      persistedPendingReviewItems
        .filter((item) => item.reason === "contradiction_review")
        .slice(0, 6),
    [persistedPendingReviewItems],
  );
  const filteredContradictionPendingReviewItems = useMemo(() => {
    if (contradictionQueueConfidence === "all") return contradictionPendingReviewItems;
    const minRank = contradictionQueueConfidence === "high" ? 3 : 2;
    return contradictionPendingReviewItems.filter(
      (item) => reviewConfidenceRank(item.confidence) >= minRank,
    );
  }, [contradictionPendingReviewItems, contradictionQueueConfidence]);
  const nonContradictionPendingReviewItems = useMemo(
    () =>
      persistedPendingReviewItems
        .filter((item) => item.reason !== "contradiction_review")
        .slice(0, 6),
    [persistedPendingReviewItems],
  );
  const persistedPendingReviewCount = landscapeReviewItems.data?.count ?? 0;
  const riskyReplayRuns = useMemo(
    () =>
      (landscapeReplayComparison.data?.runs ?? [])
        .filter(
          (run) =>
            run.comparison === "lost_baseline" ||
            run.comparison === "no_current_match" ||
            run.comparison === "drifted" ||
            run.usedBaselineLostKnowledgeIds.length > 0 ||
            run.baselineVerdicts.offTopic + run.baselineVerdicts.wrong > 0,
        )
        .slice(0, 4),
    [landscapeReplayComparison.data?.runs],
  );
  const sandboxComparisonRuns = useMemo(
    () => landscapeReplayComparison.data?.runs ?? [],
    [landscapeReplayComparison.data?.runs],
  );
  const selectedSandboxRun = useMemo(() => {
    if (!selectedSandboxRunId) return null;
    return sandboxComparisonRuns.find((run) => run.runId === selectedSandboxRunId) ?? null;
  }, [sandboxComparisonRuns, selectedSandboxRunId]);
  const changedSandboxKnowledgeIds = useMemo(
    () => sandboxChangedKnowledgeIds(selectedSandboxRun, sandboxDiffFilter),
    [selectedSandboxRun, sandboxDiffFilter],
  );
  const communityKeyByKnowledgeId = useMemo(() => {
    const map = new Map<string, string>();
    for (const node of graph.data?.nodes ?? []) {
      if (node.kind !== "knowledge") continue;
      if (!node.communityKey) continue;
      const knowledgeId = node.id.replace(/^knowledge:/, "");
      map.set(knowledgeId, node.communityKey);
    }
    return map;
  }, [graph.data?.nodes]);
  const trajectoryHighlightKnowledgeIds = useMemo(() => {
    const ids = new Set<string>();
    for (const candidate of landscapeTrajectory.data?.candidates ?? []) {
      if (!matchesTrajectoryStage(candidate, selectedTrajectoryStage)) continue;
      ids.add(candidate.itemId);
    }
    return ids;
  }, [landscapeTrajectory.data?.candidates, selectedTrajectoryStage]);
  const sandboxHighlightCommunityKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const knowledgeId of changedSandboxKnowledgeIds) {
      const communityKey = communityKeyByKnowledgeId.get(knowledgeId);
      if (communityKey) keys.add(communityKey);
    }
    return keys;
  }, [changedSandboxKnowledgeIds, communityKeyByKnowledgeId]);
  const contradictionOverlayItems = landscapeContradictions.data?.items ?? [];
  const contradictionOverlayEdges = useMemo(() => {
    if (inCommunitySupernodeMode)
      return [] as Array<{
        id: string;
        pairKey: string;
        sourceNodeId: string;
        targetNodeId: string;
        confidence: number;
        status: LandscapeContradictionOverlayItem["status"];
        confidenceLabel: LandscapeContradictionOverlayItem["confidenceLabel"];
        evidencePreview: string;
      }>;

    return contradictionOverlayItems
      .map((item) => {
        const sourceNodeId = `knowledge:${item.leftKnowledgeId}`;
        const targetNodeId = `knowledge:${item.rightKnowledgeId}`;
        const evidencePreview = item.evidence.slice(0, 2).join(" / ");
        return {
          id: `${item.pairKey}:${item.reviewItemId}`,
          pairKey: item.pairKey,
          sourceNodeId,
          targetNodeId,
          confidence: item.confidence,
          status: item.status,
          confidenceLabel: item.confidenceLabel,
          evidencePreview,
        };
      })
      .filter(
        (edge) =>
          Boolean(nodeById.get(edge.sourceNodeId)) &&
          Boolean(nodeById.get(edge.targetNodeId)) &&
          edge.sourceNodeId !== edge.targetNodeId,
      );
  }, [contradictionOverlayItems, inCommunitySupernodeMode, nodeById]);
  const activeId = selectedId ?? hoveredId;
  const totalEdges =
    displayEdgesSource.length +
    (viewMode === "community" && showContradictionOverlay ? contradictionOverlayEdges.length : 0);
  const displayedNodeCount =
    viewMode === "evidence"
      ? (graph.data?.stats.visibleKnowledgeCount ?? 0) + (graph.data?.stats.sourceNodeCount ?? 0)
      : (graph.data?.stats.visibleKnowledgeCount ?? 0);

  const saveCommunityLabel = useMutation({
    mutationFn: async (input: { communityKey: string; label: string }) =>
      updateGraphCommunityLabel({ communityKey: input.communityKey, label: input.label }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["graph"] }),
        queryClient.invalidateQueries({ queryKey: ["graph-landscape"] }),
        queryClient.invalidateQueries({ queryKey: ["graph-landscape-replay"] }),
        queryClient.invalidateQueries({ queryKey: ["graph-landscape-replay-compare"] }),
      ]);
    },
  });

  const createReviewItems = useMutation({
    mutationFn: materializeLandscapeReviewItems,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["graph-landscape-review-items"] }),
        queryClient.invalidateQueries({ queryKey: ["graph-landscape-replay-compare"] }),
      ]);
    },
  });

  const createCandidateDrafts = useMutation({
    mutationFn: createLandscapeReviewCandidates,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["graph-landscape-review-items"] }),
        queryClient.invalidateQueries({ queryKey: ["graph-landscape-replay-compare"] }),
      ]);
    },
  });

  const updateReviewItemStatus = useMutation({
    mutationFn: async (input: { id: string; status: LandscapeReviewItem["status"] }) =>
      updateLandscapeReviewItemStatus(input.id, {
        status: input.status,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["graph-landscape-review-items"] });
    },
  });

  useEffect(() => {
    setCommunityLabelDraft(selectedCommunity?.communityLabel ?? "");
  }, [selectedCommunity?.communityLabel]);

  useEffect(() => {
    if (viewMode !== "community") {
      setSelectedTrajectoryRunId(null);
      setSelectedTrajectoryStage("all");
      setSelectedSandboxRunId(null);
      setSandboxDiffFilter("all");
      return;
    }
    if (
      selectedTrajectoryRunId &&
      !riskyReplayRuns.some((run) => run.runId === selectedTrajectoryRunId)
    ) {
      setSelectedTrajectoryRunId(null);
      setSelectedTrajectoryStage("all");
    }
    if (
      selectedSandboxRunId &&
      !sandboxComparisonRuns.some((run) => run.runId === selectedSandboxRunId)
    ) {
      setSelectedSandboxRunId(null);
      setSandboxDiffFilter("all");
    }
  }, [
    viewMode,
    riskyReplayRuns,
    sandboxComparisonRuns,
    selectedTrajectoryRunId,
    selectedSandboxRunId,
  ]);

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
    dragged.current = false;
    dragStart.current = { x: e.clientX - transform.x, y: e.clientY - transform.y };
  };

  const onMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return;
    dragged.current = true;
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
            <option value="community">Community</option>
            <option value="evidence">Evidence</option>
          </Select>
          {viewMode === "community" ? (
            <Select
              value={communityDisplayMode}
              onChange={(event) => {
                setSelectedId(null);
                setHoveredId(null);
                setHasInteracted(false);
                setCommunityDisplayMode(event.target.value as GraphCommunityDisplayMode);
              }}
              className="h-8 text-xs"
            >
              <option value="detail">Detail</option>
              <option value="supernode">Supernode</option>
            </Select>
          ) : null}
          {viewMode === "community" ? (
            <div className="graph-contradiction-controls">
              <label htmlFor="graph-contradiction-overlay" className="graph-axis-toggle">
                <Checkbox
                  id="graph-contradiction-overlay"
                  checked={showContradictionOverlay}
                  onChange={() => setShowContradictionOverlay((prev) => !prev)}
                />
                <span className="graph-axis-label semantic">Contradiction</span>
              </label>
              {showContradictionOverlay ? (
                <>
                  <Select
                    aria-label="contradiction-status-filter"
                    value={contradictionStatus}
                    onChange={(event) =>
                      setContradictionStatus(
                        event.target.value as
                          | "pending"
                          | "reviewing"
                          | "resolved"
                          | "dismissed"
                          | "all",
                      )
                    }
                    className="h-8 text-xs"
                  >
                    <option value="pending">pending</option>
                    <option value="reviewing">reviewing</option>
                    <option value="all">all</option>
                    <option value="resolved">resolved</option>
                    <option value="dismissed">dismissed</option>
                  </Select>
                  <Select
                    aria-label="contradiction-confidence-filter"
                    value={String(contradictionConfidenceMin)}
                    onChange={(event) =>
                      setContradictionConfidenceMin(Number.parseFloat(event.target.value) || 0.62)
                    }
                    className="h-8 text-xs"
                  >
                    <option value="0.5">conf ≥ 0.50</option>
                    <option value="0.62">conf ≥ 0.62</option>
                    <option value="0.72">conf ≥ 0.72</option>
                    <option value="0.82">conf ≥ 0.82</option>
                  </Select>
                </>
              ) : null}
            </div>
          ) : null}
          {viewMode === "relation" || viewMode === "community" ? (
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
            Semantic / Relation / Community / Evidence を切り替えて確認します。
          </p>
        </div>
        <div className="graph-legend-overlay">
          {viewMode === "community" ? (
            <>
              <div className="legend-item">
                <span className="legend-dot procedure" />
                <span>Node Color: Community</span>
              </div>
              <div className="legend-item">
                <span className="legend-chip attractor" />
                <span>Strong Attractor</span>
              </div>
              <div className="legend-item">
                <span className="legend-chip negative" />
                <span>Negative Candidate</span>
              </div>
              <div className="legend-item">
                <span className="legend-chip dead-zone" />
                <span>Dead Zone</span>
              </div>
              {changedSandboxKnowledgeIds.length > 0 ? (
                <div className="legend-item">
                  <span className="legend-chip sandbox" />
                  <span>Sandbox Affected</span>
                </div>
              ) : null}
            </>
          ) : (
            <>
              <div className="legend-item">
                <span className="legend-dot rule" />
                <span>Rule</span>
              </div>
              <div className="legend-item">
                <span className="legend-dot procedure" />
                <span>Procedure</span>
              </div>
              {viewMode === "evidence" ? (
                <div className="legend-item">
                  <span className="legend-dot source" />
                  <span>Source</span>
                </div>
              ) : null}
            </>
          )}
          {inCommunitySupernodeMode ? (
            <div className="legend-item">
              <span className="legend-line community" />
              <span>Community Link</span>
            </div>
          ) : viewMode === "semantic" ? (
            <div className="legend-item">
              <span className="legend-line semantic" />
              <span>Semantic Edge</span>
            </div>
          ) : viewMode === "evidence" ? (
            <div className="legend-item">
              <span className="legend-line evidence" />
              <span>Evidence Link</span>
            </div>
          ) : (
            <>
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
            </>
          )}
          {viewMode === "community" && showContradictionOverlay ? (
            <div className="legend-item">
              <span className="legend-line contradiction" />
              <span>Contradiction Edge</span>
            </div>
          ) : null}
          <p className="graph-legend-note">
            {viewMode === "semantic"
              ? "semantic: cosine 類似度（minSimilarity=0.72, topK=3）"
              : viewMode === "evidence"
                ? "evidence: knowledge_source_links 由来の knowledge -> source 直接リンク"
                : viewMode === "community"
                  ? inCommunitySupernodeMode
                    ? "community: cluster を supernode に圧縮して表示します"
                    : "community: relation edge の連結成分で grouping します"
                  : "relation: session/project 軸を同時に表示できます"}
          </p>
        </div>
      </div>

      <div className="graph-overlay-stats">
        <div className="graph-stats-overlay">
          <div className="stat-row">
            <span>Nodes</span>
            <strong>{displayedNodeCount}</strong>
          </div>
          <div className="stat-row">
            <span>Edges</span>
            <strong>{totalEdges}</strong>
          </div>
          {viewMode === "community" && showContradictionOverlay ? (
            <div className="stat-row graph-stats-subtle">
              <span>Contradictions</span>
              <strong>{contradictionOverlayEdges.length}</strong>
            </div>
          ) : null}
          {viewMode === "community" && changedSandboxKnowledgeIds.length > 0 ? (
            <div className="stat-row graph-stats-subtle">
              <span>
                {sandboxDiffFilter === "all" ? "Sandbox Changed IDs" : "Sandbox Filter IDs"}
              </span>
              <strong>{changedSandboxKnowledgeIds.length}</strong>
            </div>
          ) : null}
          <div className="stat-row">
            <span>Embedded</span>
            <strong>{graph.data?.stats.embeddedKnowledgeCount ?? 0}</strong>
          </div>
          {viewMode === "semantic" ? (
            <div className="stat-row graph-stats-subtle">
              <span>Semantic</span>
              <strong>{graph.data?.stats.semanticEdgeCount ?? 0}</strong>
            </div>
          ) : viewMode === "evidence" ? (
            <>
              <div className="stat-row graph-stats-subtle">
                <span>Source Nodes</span>
                <strong>{graph.data?.stats.sourceNodeCount ?? 0}</strong>
              </div>
              <div className="stat-row graph-stats-subtle">
                <span>Evidence Edges</span>
                <strong>{graph.data?.stats.evidenceEdgeCount ?? 0}</strong>
              </div>
              <div className="stat-row graph-stats-subtle">
                <span>Linked</span>
                <strong>{graph.data?.stats.evidenceLinkedKnowledgeCount ?? 0}</strong>
              </div>
              <div className="stat-row graph-stats-subtle">
                <span>Unlinked</span>
                <strong>{graph.data?.stats.evidenceUnlinkedKnowledgeCount ?? 0}</strong>
              </div>
              {(graph.data?.stats.truncatedSourceNodeCount ?? 0) > 0 ? (
                <div className="stat-row graph-stats-subtle">
                  <span>Truncated Sources</span>
                  <strong>{graph.data?.stats.truncatedSourceNodeCount ?? 0}</strong>
                </div>
              ) : null}
            </>
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
              {viewMode === "community" ? (
                <>
                  <div className="stat-row graph-stats-subtle">
                    <span>Communities</span>
                    <strong>{graph.data?.stats.communityCount ?? 0}</strong>
                  </div>
                  <div className="stat-row graph-stats-subtle">
                    <span>Largest</span>
                    <strong>{graph.data?.stats.largestCommunitySize ?? 0}</strong>
                  </div>
                  <div className="stat-row graph-stats-subtle">
                    <span>Orphans</span>
                    <strong>{graph.data?.stats.orphanNodeCount ?? 0}</strong>
                  </div>
                  <div className="stat-row graph-stats-subtle">
                    <span>Cold</span>
                    <strong>{graph.data?.stats.deadCommunityCount ?? 0}</strong>
                  </div>
                  <div className="stat-row graph-stats-subtle">
                    <span>Stale</span>
                    <strong>{graph.data?.stats.staleCommunityCount ?? 0}</strong>
                  </div>
                  <div className="stat-row graph-stats-subtle">
                    <span>Thin</span>
                    <strong>{graph.data?.stats.thinEvidenceCommunityCount ?? 0}</strong>
                  </div>
                  <div className="stat-row graph-stats-subtle">
                    <span>Strong Attractor</span>
                    <strong>{landscape.data?.stats.strongAttractorCount ?? 0}</strong>
                  </div>
                  <div className="stat-row graph-stats-subtle">
                    <span>Negative Candidate</span>
                    <strong>{landscape.data?.stats.negativeCandidateCount ?? 0}</strong>
                  </div>
                  <div className="stat-row graph-stats-subtle">
                    <span>Dead Reachability</span>
                    <strong>{landscape.data?.stats.deadZoneReachabilityCount ?? 0}</strong>
                  </div>
                </>
              ) : null}
            </>
          )}
        </div>
      </div>

      {selectedId ? (
        <div className="graph-overlay-right-detail" style={{ top: detailPanelTop }}>
          <aside className="graph-detail-panel" aria-live="polite">
            <div className="graph-detail-panel-header">
              <span className="graph-detail-kicker">Node Detail</span>
              <strong>
                {viewMode === "semantic"
                  ? "Semantic"
                  : viewMode === "evidence"
                    ? "Evidence"
                    : viewMode === "community"
                      ? "Community"
                      : "Relation"}
              </strong>
            </div>
            {selectedId ? (
              selectedRawId ? (
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
                      {viewMode === "community" ? (
                        <>
                          <div className="graph-detail-metric">
                            <span>Community</span>
                            <strong>
                              {selectedNode?.communityLabel ?? selectedNode?.communityId ?? "-"}
                            </strong>
                          </div>
                          <div className="graph-detail-metric">
                            <span>Rank</span>
                            <strong>{selectedNode?.communityRank ?? "-"}</strong>
                          </div>
                          <div className="graph-detail-metric">
                            <span>Size</span>
                            <strong>{selectedNode?.communitySize ?? "-"}</strong>
                          </div>
                        </>
                      ) : null}
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
                      {viewMode === "community" ? (
                        <Badge
                          variant="outline"
                          className="h-5 border-sky-300 text-[11px] text-sky-100"
                        >
                          {selectedNode.communityLabel ?? selectedNode.communityId ?? "community:-"}
                        </Badge>
                      ) : null}
                    </div>
                    <h2 className="graph-detail-title">{selectedNode.label}</h2>
                    <div className="graph-detail-empty">
                      Detail fetch failed. Showing graph data.
                    </div>
                  </>
                ) : null
              ) : selectedNode ? (
                selectedNode.kind === "source" ? (
                  <>
                    <div className="graph-detail-badges">
                      <Badge variant="secondary" className="h-5 text-[11px]">
                        Source
                      </Badge>
                      <Badge
                        variant="outline"
                        className="h-5 border-cyan-300 text-[11px] text-cyan-100"
                      >
                        {selectedNode.sourceKind ?? "source"}
                      </Badge>
                    </div>
                    <h2 className="graph-detail-title">{selectedNode.label}</h2>
                    <div className="graph-detail-meta-grid">
                      <div className="graph-detail-metric">
                        <span>Linked Knowledge</span>
                        <strong>{selectedNode.linkedKnowledgeCount ?? 0}</strong>
                      </div>
                      <div className="graph-detail-metric">
                        <span>Weight</span>
                        <strong>{selectedNode.weight.toFixed(2)}</strong>
                      </div>
                      <div className="graph-detail-metric">
                        <span>Source ID</span>
                        <strong>{selectedNode.sourceId ?? "-"}</strong>
                      </div>
                      <div className="graph-detail-metric">
                        <span>Kind</span>
                        <strong>{selectedNode.kind}</strong>
                      </div>
                    </div>
                    <div className="graph-detail-body">
                      <span>URI</span>
                      <p>{selectedNode.sourceUri ?? "-"}</p>
                    </div>
                    <div className="graph-detail-id">{selectedId}</div>
                  </>
                ) : (
                  <>
                    <div className="graph-detail-badges">
                      <Badge variant="secondary" className="h-5 text-[11px]">
                        Community
                      </Badge>
                      <Badge
                        variant="outline"
                        className="h-5 border-slate-400 text-[11px] text-slate-50"
                      >
                        {selectedNode.communityLabel ?? selectedNode.id}
                      </Badge>
                      {selectedNode.healthDead ? (
                        <Badge
                          variant="outline"
                          className="h-5 border-rose-300 text-[11px] text-rose-100"
                        >
                          cold
                        </Badge>
                      ) : selectedNode.healthStale ? (
                        <Badge
                          variant="outline"
                          className="h-5 border-amber-300 text-[11px] text-amber-100"
                        >
                          warm
                        </Badge>
                      ) : selectedNode.healthThinEvidence ? (
                        <Badge
                          variant="outline"
                          className="h-5 border-sky-300 text-[11px] text-sky-100"
                        >
                          warm
                        </Badge>
                      ) : (
                        <Badge
                          variant="outline"
                          className="h-5 border-emerald-300 text-[11px] text-emerald-100"
                        >
                          hot
                        </Badge>
                      )}
                    </div>
                    <h2 className="graph-detail-title">
                      {selectedNode.communityLabel ?? selectedNode.label}
                    </h2>
                    <div className="graph-detail-meta-grid">
                      <div className="graph-detail-metric">
                        <span>Community</span>
                        <strong>{selectedNode.communityId ?? selectedNode.id}</strong>
                      </div>
                      <div className="graph-detail-metric">
                        <span>Size</span>
                        <strong>{selectedNode.communitySize ?? "-"}</strong>
                      </div>
                      <div className="graph-detail-metric">
                        <span>Rank</span>
                        <strong>{selectedNode.communityRank ?? "-"}</strong>
                      </div>
                    </div>
                  </>
                )
              ) : (
                <div className="graph-detail-empty">Select a node to view details</div>
              )
            ) : (
              <div className="graph-detail-empty">Select a node to view details</div>
            )}
            {viewMode === "community" ? (
              <section className="graph-community-summary-panel">
                <div className="graph-community-summary-header">
                  <span className="graph-detail-kicker">Community Summary</span>
                  <strong>{selectedCommunity?.communityLabel ?? "-"}</strong>
                </div>
                <div className="graph-landscape-cache-status">
                  <span className="graph-detail-kicker">Snapshot Cache</span>
                  {landscapeSnapshotCacheStatus.isLoading ? (
                    <p>Loading cache status...</p>
                  ) : landscapeSnapshotCacheStatus.data ? (
                    <>
                      <p>
                        {landscapeSnapshotCacheStatus.data.enabled
                          ? `enabled ttl=${landscapeSnapshotCacheStatus.data.ttlSeconds}s`
                          : `disabled ttl=${landscapeSnapshotCacheStatus.data.ttlSeconds}s`}
                        {landscapeSnapshotCacheStatus.data.disabledReason
                          ? ` (${landscapeSnapshotCacheStatus.data.disabledReason})`
                          : ""}
                      </p>
                      <div className="graph-cache-table-wrap">
                        <table className="graph-cache-table">
                          <thead>
                            <tr>
                              <th>Type</th>
                              <th>Ready</th>
                              <th>Stale</th>
                              <th>Expired</th>
                              <th>Oldest</th>
                              <th>Latest</th>
                              <th>Expires</th>
                              <th>Size</th>
                              <th>Last Purge</th>
                            </tr>
                          </thead>
                          <tbody>
                            {landscapeSnapshotCacheStatus.data.snapshots.map((snapshot) => (
                              <tr key={`cache-${snapshot.snapshotType}`}>
                                <td>{landscapeSnapshotCacheTypeLabel(snapshot.snapshotType)}</td>
                                <td>{snapshot.readyCount}</td>
                                <td>{snapshot.staleCount}</td>
                                <td>{snapshot.expiredReadyCount}</td>
                                <td>{snapshot.oldestGeneratedAt ?? "-"}</td>
                                <td>{snapshot.latestGeneratedAt ?? "-"}</td>
                                <td>{snapshot.latestExpiresAt ?? "-"}</td>
                                <td>{formatBytes(snapshot.estimatedPayloadBytes)}</td>
                                <td>
                                  {snapshot.lastPurge
                                    ? `${snapshot.lastPurge.deletedCount} @ ${snapshot.lastPurge.purgedAt}`
                                    : "-"}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  ) : (
                    <p>Cache status unavailable.</p>
                  )}
                </div>
                {selectedCommunity ? (
                  <>
                    <div className="graph-landscape-card">
                      <div className="graph-landscape-card-header">
                        <span className="graph-detail-kicker">Dynamic Health Card</span>
                        <Badge
                          variant="outline"
                          className={`h-5 text-[11px] ${
                            selectedLandscapeCommunity?.classification.primary ===
                            "strong_attractor"
                              ? "border-emerald-300 text-emerald-100"
                              : selectedLandscapeCommunity?.classification.primary ===
                                    "negative_attractor_candidate" ||
                                  selectedLandscapeCommunity?.classification.primary ===
                                    "dead_zone_reachability_risk" ||
                                  selectedLandscapeCommunity?.classification.primary ===
                                    "dead_zone_stale"
                                ? "border-rose-300 text-rose-100"
                                : selectedLandscapeCommunity?.classification.primary ===
                                    "over_selected_not_used"
                                  ? "border-amber-300 text-amber-100"
                                  : "border-slate-300 text-slate-100"
                          }`}
                        >
                          {selectedLandscapeCommunity
                            ? landscapePrimaryLabel(
                                selectedLandscapeCommunity.classification.primary,
                              )
                            : "No snapshot"}
                        </Badge>
                      </div>
                      {landscape.isLoading ? (
                        <div className="graph-detail-empty">Loading landscape snapshot...</div>
                      ) : selectedLandscapeCommunity ? (
                        <>
                          <div className="graph-detail-meta-grid">
                            <div className="graph-detail-metric">
                              <span>Selected (30d)</span>
                              <strong>
                                {selectedLandscapeCommunity.selection.selectedItemCountWindow}
                              </strong>
                            </div>
                            <div className="graph-detail-metric">
                              <span>Runs (30d)</span>
                              <strong>
                                {selectedLandscapeCommunity.selection.selectedRunCountWindow}
                              </strong>
                            </div>
                            <div className="graph-detail-metric">
                              <span>Feedback</span>
                              <strong>
                                {landscapeConfidenceLabel(
                                  selectedLandscapeCommunity.feedback.feedbackConfidence,
                                )}
                              </strong>
                            </div>
                            <div className="graph-detail-metric">
                              <span>Source Density</span>
                              <strong>
                                {selectedLandscapeCommunity.quality.sourceRefDensity.toFixed(2)}
                              </strong>
                            </div>
                          </div>
                          <div className="graph-community-summary-grid">
                            <div className="graph-community-summary-item">
                              <span>Used</span>
                              <p>
                                {selectedLandscapeCommunity.feedback.usedCountWindow} (
                                {Math.round(selectedLandscapeCommunity.feedback.usedRate * 100)}%)
                              </p>
                            </div>
                            <div className="graph-community-summary-item">
                              <span>Not Used</span>
                              <p>
                                {selectedLandscapeCommunity.feedback.notUsedCountWindow} (
                                {Math.round(selectedLandscapeCommunity.feedback.notUsedRate * 100)}
                                %)
                              </p>
                            </div>
                            <div className="graph-community-summary-item">
                              <span>Off Topic</span>
                              <p>
                                {selectedLandscapeCommunity.feedback.offTopicCountWindow} (
                                {Math.round(selectedLandscapeCommunity.feedback.offTopicRate * 100)}
                                %)
                              </p>
                            </div>
                            <div className="graph-community-summary-item">
                              <span>Wrong</span>
                              <p>
                                {selectedLandscapeCommunity.feedback.wrongCountWindow} (
                                {Math.round(selectedLandscapeCommunity.feedback.wrongRate * 100)}%)
                              </p>
                            </div>
                          </div>
                          <div className="graph-community-summary-item">
                            <span>Reason</span>
                            <p>{selectedLandscapeCommunity.classification.reason}</p>
                          </div>
                          <div className="graph-community-summary-item">
                            <span>Recommended Actions</span>
                            <p>{selectedLandscapeCommunity.recommendedActions.join(" / ")}</p>
                          </div>
                        </>
                      ) : (
                        <div className="graph-detail-empty">
                          Landscape snapshot for this community is not available.
                        </div>
                      )}
                    </div>
                    <div className="graph-landscape-card">
                      <div className="graph-landscape-card-header">
                        <span className="graph-detail-kicker">Replay Health</span>
                        <Badge
                          variant="outline"
                          className={`h-5 text-[11px] ${
                            selectedCommunityComparison?.comparison ===
                            "semantic_reachable_dead_zone"
                              ? "border-rose-300 text-rose-100"
                              : selectedCommunityComparison?.comparison === "semantic_split" ||
                                  selectedCommunityComparison?.comparison === "semantic_merge"
                                ? "border-amber-300 text-amber-100"
                                : "border-slate-300 text-slate-100"
                          }`}
                        >
                          {selectedCommunityComparison
                            ? communityComparisonLabel(selectedCommunityComparison.comparison)
                            : "No replay"}
                        </Badge>
                      </div>
                      {landscapeReplay.isLoading ? (
                        <div className="graph-detail-empty">Loading replay snapshot...</div>
                      ) : landscapeReplay.data ? (
                        <>
                          <div className="graph-detail-meta-grid">
                            <div className="graph-detail-metric">
                              <span>Replay Runs</span>
                              <strong>{landscapeReplay.data.replayRunCount}</strong>
                            </div>
                            <div className="graph-detail-metric">
                              <span>Selected</span>
                              <strong>{selectedReplayCommunity?.selectedItemCount ?? 0}</strong>
                            </div>
                            <div className="graph-detail-metric">
                              <span>Accepted</span>
                              <strong>
                                {selectedReplayCommunity?.acceptanceWindow.acceptedCountWindow ??
                                  landscapeReplay.data.acceptanceWindow.acceptedCountWindow}
                              </strong>
                            </div>
                            <div className="graph-detail-metric">
                              <span>Missing</span>
                              <strong>{landscapeReplay.data.missingKnowledgeCount}</strong>
                            </div>
                          </div>
                          {selectedReplayCommunity ? (
                            <div className="graph-community-summary-grid">
                              <div className="graph-community-summary-item">
                                <span>Replay Used</span>
                                <p>{selectedReplayCommunity.verdictMix.used}</p>
                              </div>
                              <div className="graph-community-summary-item">
                                <span>Replay Off Topic</span>
                                <p>{selectedReplayCommunity.verdictMix.offTopic}</p>
                              </div>
                              <div className="graph-community-summary-item">
                                <span>Aligned</span>
                                <p>{selectedReplayCommunity.explanationCounts.aligned_attractor}</p>
                              </div>
                              <div className="graph-community-summary-item">
                                <span>Dead Miss</span>
                                <p>{selectedReplayCommunity.explanationCounts.dead_zone_missed}</p>
                              </div>
                            </div>
                          ) : (
                            <div className="graph-detail-empty">
                              Replay data for this community is not available.
                            </div>
                          )}
                          {selectedCommunityComparison ? (
                            <div className="graph-community-summary-item">
                              <span>Semantic / Relation</span>
                              <p>
                                overlap {selectedCommunityComparison.jaccardOverlap.toFixed(2)} /
                                neighbors {selectedCommunityComparison.selectedNeighborCountWindow}
                              </p>
                            </div>
                          ) : null}
                          {topReplayFacetRisks.length > 0 ? (
                            <div className="graph-community-summary-item">
                              <span>Top Facet Risks</span>
                              <p>
                                {topReplayFacetRisks
                                  .map(
                                    (facet) =>
                                      `${facet.facetKind}:${facet.facetValue} (${facet.negativeCandidateHitCount + facet.overSelectedHitCount + facet.deadZoneMissCount})`,
                                  )
                                  .join(" / ")}
                              </p>
                            </div>
                          ) : null}
                        </>
                      ) : (
                        <div className="graph-detail-empty">Replay snapshot is not available.</div>
                      )}
                    </div>
                    <div className="graph-landscape-card">
                      <div className="graph-landscape-card-header">
                        <span className="graph-detail-kicker">Replay Review</span>
                        <Badge
                          variant="outline"
                          className={`h-5 text-[11px] ${
                            landscapeReplayComparison.data?.promotionGateSummary.gateMode ===
                            "review_required"
                              ? "border-rose-300 text-rose-100"
                              : "border-emerald-300 text-emerald-100"
                          }`}
                        >
                          {landscapeReplayComparison.data?.promotionGateSummary.gateMode ??
                            "No compare"}
                        </Badge>
                      </div>
                      {landscapeReplayComparison.isLoading ? (
                        <div className="graph-detail-empty">Loading replay comparison...</div>
                      ) : landscapeReplayComparison.data ? (
                        <>
                          <div className="graph-detail-meta-grid">
                            <div className="graph-detail-metric">
                              <span>Compared Runs</span>
                              <strong>{landscapeReplayComparison.data.comparedRunCount}</strong>
                            </div>
                            <div className="graph-detail-metric">
                              <span>Overlap</span>
                              <strong>
                                {formatPercent(landscapeReplayComparison.data.averageOverlapRate)}
                              </strong>
                            </div>
                            <div className="graph-detail-metric">
                              <span>Used Lost</span>
                              <strong>
                                {landscapeReplayComparison.data.usedBaselineLostItemCount}
                              </strong>
                            </div>
                            <div className="graph-detail-metric">
                              <span>Pending Items</span>
                              <strong>{persistedPendingReviewCount}</strong>
                            </div>
                          </div>
                          <div className="graph-community-summary-grid">
                            <div className="graph-community-summary-item">
                              <span>Promotion Gate</span>
                              <p>
                                {
                                  landscapeReplayComparison.data.promotionGateSummary
                                    .affectedRunCount
                                }{" "}
                                runs /{" "}
                                {
                                  landscapeReplayComparison.data.promotionGateSummary
                                    .riskyNewKnowledgeCount
                                }{" "}
                                new
                              </p>
                            </div>
                            <div className="graph-community-summary-item">
                              <span>Score Tuning</span>
                              <p>
                                churn {landscapeReplayComparison.data.scoreTuning.highChurnRunCount}{" "}
                                / negative{" "}
                                {
                                  landscapeReplayComparison.data.scoreTuning
                                    .negativeFeedbackRunCount
                                }
                              </p>
                            </div>
                            <div className="graph-community-summary-item">
                              <span>Compile Plan</span>
                              <p>
                                {landscapeReplayComparison.data.compileInterventionPlan.strategy} (
                                {
                                  landscapeReplayComparison.data.compileInterventionPlan
                                    .candidateRunCount
                                }
                                )
                              </p>
                            </div>
                            <div className="graph-community-summary-item">
                              <span>Dry Run</span>
                              <p>
                                writes:
                                {String(
                                  landscapeReplayComparison.data.recompilePlan.writesCompileRuns,
                                )}{" "}
                                / blockers:
                                {landscapeReplayComparison.data.recompilePlan.blockers.length}
                              </p>
                            </div>
                          </div>
                          <div className="graph-review-section">
                            <div className="graph-review-section-header">
                              <span>Action Queue</span>
                              <strong>{persistedPendingReviewCount}</strong>
                            </div>
                            <div className="graph-review-actions">
                              <Button
                                size="sm"
                                className="h-7 px-2 text-[11px]"
                                onClick={() =>
                                  createCandidateDrafts.mutate({
                                    status: "pending",
                                    limit: 20,
                                    dryRun: false,
                                  })
                                }
                                disabled={createCandidateDrafts.isPending}
                              >
                                {createCandidateDrafts.isPending
                                  ? "Creating..."
                                  : "Create Candidate Drafts"}
                              </Button>
                              {createCandidateDrafts.data ? (
                                <span className="graph-review-status-note">
                                  created {createCandidateDrafts.data.createdCount} / existing{" "}
                                  {createCandidateDrafts.data.existingCount}
                                </span>
                              ) : null}
                              <Button
                                size="sm"
                                className="h-7 px-2 text-[11px]"
                                onClick={() =>
                                  createReviewItems.mutate({
                                    dryRun: false,
                                    windowDays: 30,
                                    limit: 25,
                                    runStatus: "all",
                                    currentLimit: 12,
                                    landscapeLimit: 1000,
                                    landscapeStatus: statusFilter,
                                    relationAxes,
                                    minSelectedCount: 3,
                                    minFeedbackCount: 3,
                                    minSimilarity: 0.72,
                                    semanticTopK: 3,
                                    sources: [
                                      "replay_compare",
                                      "landscape_snapshot",
                                      "semantic_relation_comparison",
                                      "promotion_gate",
                                      "contradiction_detection",
                                    ],
                                    materializeLimit: 50,
                                  })
                                }
                                disabled={createReviewItems.isPending}
                              >
                                {createReviewItems.isPending
                                  ? "Creating..."
                                  : "Create Review Items"}
                              </Button>
                              {createReviewItems.data ? (
                                <span className="graph-review-status-note">
                                  inserted {createReviewItems.data.insertedCount} / existing{" "}
                                  {createReviewItems.data.existingCount}
                                </span>
                              ) : null}
                            </div>
                            {landscapeReviewItems.isLoading ? (
                              <div className="graph-detail-empty">Loading persisted items...</div>
                            ) : nonContradictionPendingReviewItems.length > 0 ? (
                              <div className="graph-review-list">
                                {nonContradictionPendingReviewItems.map((item) => {
                                  const payload = item.payload as Record<string, unknown>;
                                  const linkedTargetStateId =
                                    typeof payload.lastCandidateTargetStateId === "string"
                                      ? payload.lastCandidateTargetStateId
                                      : "";
                                  const needsPromotionGateWarning =
                                    reviewItemNeedsPromotionGateWarning(item);
                                  const suggestedAppliesTo = item.suggestedAppliesTo as {
                                    retrievalMode?: string;
                                    changeTypes?: unknown;
                                    technologies?: unknown;
                                    domains?: unknown;
                                  };
                                  const changeTypes = Array.isArray(suggestedAppliesTo.changeTypes)
                                    ? suggestedAppliesTo.changeTypes.filter(
                                        (value): value is string => typeof value === "string",
                                      )
                                    : [];
                                  const technologies = Array.isArray(
                                    suggestedAppliesTo.technologies,
                                  )
                                    ? suggestedAppliesTo.technologies.filter(
                                        (value): value is string => typeof value === "string",
                                      )
                                    : [];
                                  const domains = Array.isArray(suggestedAppliesTo.domains)
                                    ? suggestedAppliesTo.domains.filter(
                                        (value): value is string => typeof value === "string",
                                      )
                                    : [];
                                  return (
                                    <div className="graph-review-row" key={item.id}>
                                      <div className="graph-review-row-head">
                                        <Badge
                                          variant="outline"
                                          className={`h-5 text-[11px] ${
                                            item.reason === "baseline_wrong" ||
                                            item.reason === "wrong_review_required"
                                              ? "border-rose-300 text-rose-100"
                                              : item.reason === "baseline_off_topic" ||
                                                  item.reason === "semantic_split" ||
                                                  item.reason === "semantic_merge"
                                                ? "border-amber-300 text-amber-100"
                                                : "border-sky-300 text-sky-100"
                                          }`}
                                        >
                                          {reviewItemReasonLabel(item.reason)}
                                        </Badge>
                                        <span>
                                          p{item.priority} / {item.confidence}
                                        </span>
                                        {needsPromotionGateWarning ? (
                                          <Badge
                                            variant="outline"
                                            className="h-5 border-rose-300 text-[11px] text-rose-100"
                                          >
                                            Warning
                                          </Badge>
                                        ) : null}
                                        {linkedTargetStateId ? (
                                          <Badge
                                            variant="outline"
                                            className="h-5 border-emerald-300 text-[11px] text-emerald-100"
                                          >
                                            Draft linked
                                          </Badge>
                                        ) : null}
                                      </div>
                                      <p>
                                        {item.knowledgeId ??
                                          item.communityLabel ??
                                          item.runId ??
                                          item.id}
                                      </p>
                                      <small>
                                        {[
                                          reviewItemActionLabel(item.proposedAction),
                                          suggestedAppliesTo.retrievalMode,
                                          ...changeTypes,
                                          ...technologies,
                                          ...domains,
                                        ]
                                          .filter(Boolean)
                                          .slice(0, 5)
                                          .join(" / ") || "no facets"}
                                      </small>
                                      {needsPromotionGateWarning ? (
                                        <small>
                                          warning: promotion gate review required / evidence:{" "}
                                          {reviewItemWarningSummary(item)}
                                        </small>
                                      ) : null}
                                      <div className="graph-review-row-actions">
                                        {linkedTargetStateId ? (
                                          <a
                                            href={`/candidates?targetStateId=${encodeURIComponent(linkedTargetStateId)}`}
                                            className="inline-flex h-7 items-center rounded-md border border-emerald-300 px-2 text-[11px] text-emerald-100 hover:bg-emerald-500/15"
                                          >
                                            View Candidate
                                          </a>
                                        ) : null}
                                        <Button
                                          size="sm"
                                          variant="outline"
                                          className="h-7 px-2 text-[11px]"
                                          disabled={updateReviewItemStatus.isPending}
                                          onClick={() =>
                                            updateReviewItemStatus.mutate({
                                              id: item.id,
                                              status: "resolved",
                                            })
                                          }
                                        >
                                          Resolve
                                        </Button>
                                        <Button
                                          size="sm"
                                          variant="outline"
                                          className="h-7 px-2 text-[11px]"
                                          disabled={updateReviewItemStatus.isPending}
                                          onClick={() =>
                                            updateReviewItemStatus.mutate({
                                              id: item.id,
                                              status: "dismissed",
                                            })
                                          }
                                        >
                                          Dismiss
                                        </Button>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            ) : (
                              <div className="graph-detail-empty">No persisted items</div>
                            )}
                          </div>
                          <div className="graph-review-section">
                            <div className="graph-review-section-header">
                              <span>Contradiction Review</span>
                              <strong>{filteredContradictionPendingReviewItems.length}</strong>
                            </div>
                            <div className="graph-review-actions">
                              <Select
                                aria-label="contradiction-queue-confidence-filter"
                                value={contradictionQueueConfidence}
                                onChange={(event) =>
                                  setContradictionQueueConfidence(
                                    event.target.value as "all" | "medium" | "high",
                                  )
                                }
                                className="h-7 text-[11px]"
                              >
                                <option value="all">all confidence</option>
                                <option value="medium">medium+</option>
                                <option value="high">high only</option>
                              </Select>
                            </div>
                            <ContradictionReviewList
                              items={filteredContradictionPendingReviewItems}
                              isUpdating={updateReviewItemStatus.isPending}
                              onResolve={(id) =>
                                updateReviewItemStatus.mutate({
                                  id,
                                  status: "resolved",
                                })
                              }
                              onDismiss={(id) =>
                                updateReviewItemStatus.mutate({
                                  id,
                                  status: "dismissed",
                                })
                              }
                            />
                          </div>
                          <div className="graph-review-section">
                            <div className="graph-review-section-header">
                              <span>Candidate Only</span>
                              <strong>{replayReviewCandidateQueue.length}</strong>
                            </div>
                            {replayReviewCandidateQueue.length > 0 ? (
                              <div className="graph-review-list">
                                {replayReviewCandidateQueue.map((candidate) => (
                                  <div
                                    className="graph-review-row"
                                    key={`${candidate.runId}:${candidate.knowledgeId}:${candidate.reason}`}
                                  >
                                    <div className="graph-review-row-head">
                                      <Badge
                                        variant="outline"
                                        className={`h-5 text-[11px] ${
                                          candidate.reason === "baseline_wrong"
                                            ? "border-rose-300 text-rose-100"
                                            : candidate.reason === "baseline_off_topic"
                                              ? "border-amber-300 text-amber-100"
                                              : "border-sky-300 text-sky-100"
                                        }`}
                                      >
                                        {reviewItemReasonLabel(candidate.reason)}
                                      </Badge>
                                      <span>{candidate.confidence}</span>
                                    </div>
                                    <p>{candidate.knowledgeId}</p>
                                    <small>
                                      {[
                                        candidate.suggestedAppliesTo.retrievalMode,
                                        ...candidate.suggestedAppliesTo.changeTypes,
                                        ...candidate.suggestedAppliesTo.technologies,
                                        ...candidate.suggestedAppliesTo.domains,
                                      ]
                                        .slice(0, 5)
                                        .join(" / ") || "no facets"}
                                    </small>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <div className="graph-detail-empty">No candidates</div>
                            )}
                          </div>
                          <div className="graph-review-section">
                            <div className="graph-review-section-header">
                              <span>Risky Runs</span>
                              <strong>{riskyReplayRuns.length}</strong>
                            </div>
                            {riskyReplayRuns.length > 0 ? (
                              <div className="graph-review-list">
                                {riskyReplayRuns.map((run) => (
                                  <div className="graph-review-row" key={run.runId}>
                                    <div className="graph-review-row-head">
                                      <Badge
                                        variant="outline"
                                        className={`h-5 text-[11px] ${
                                          run.comparison === "lost_baseline" ||
                                          run.comparison === "no_current_match"
                                            ? "border-rose-300 text-rose-100"
                                            : run.comparison === "drifted"
                                              ? "border-amber-300 text-amber-100"
                                              : "border-slate-300 text-slate-100"
                                        }`}
                                      >
                                        {replayComparisonLabel(run.comparison)}
                                      </Badge>
                                      <span>{formatPercent(run.overlapRate)}</span>
                                    </div>
                                    <p>{run.goal}</p>
                                    <small>
                                      baseline {run.baselineSelectedKnowledgeIds.length} / current{" "}
                                      {run.currentRetrievedKnowledgeIds.length} / missing{" "}
                                      {run.missingFromCurrentKnowledgeIds.length} / used lost{" "}
                                      {run.usedBaselineLostKnowledgeIds.length}
                                    </small>
                                    <div className="graph-review-row-actions">
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        className="h-7 px-2 text-[11px]"
                                        onClick={() => {
                                          setSelectedTrajectoryRunId(run.runId);
                                          setSelectedTrajectoryStage("all");
                                        }}
                                      >
                                        View Trajectory
                                      </Button>
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        className="h-7 px-2 text-[11px]"
                                        onClick={() => {
                                          setSelectedSandboxRunId(run.runId);
                                          setSandboxDiffFilter("all");
                                        }}
                                      >
                                        Compare Sandbox
                                      </Button>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <div className="graph-detail-empty">No risky runs</div>
                            )}
                            <TrajectoryPanel
                              runId={selectedTrajectoryRunId}
                              trajectory={landscapeTrajectory.data}
                              isLoading={landscapeTrajectory.isLoading}
                              stage={selectedTrajectoryStage}
                              onStageChange={setSelectedTrajectoryStage}
                              onClose={() => {
                                setSelectedTrajectoryRunId(null);
                                setSelectedTrajectoryStage("all");
                              }}
                            />
                            <SandboxComparisonPanel
                              runs={sandboxComparisonRuns}
                              selectedRunId={selectedSandboxRunId}
                              onSelectRun={setSelectedSandboxRunId}
                              diffFilter={sandboxDiffFilter}
                              onDiffFilterChange={setSandboxDiffFilter}
                              onSelectKnowledgeId={(knowledgeId) =>
                                setSelectedId(`knowledge:${knowledgeId}`)
                              }
                            />
                          </div>
                        </>
                      ) : (
                        <div className="graph-detail-empty">
                          Replay comparison is not available.
                        </div>
                      )}
                    </div>
                    <div className="graph-community-label-edit">
                      <Input
                        value={communityLabelDraft}
                        onChange={(event) => setCommunityLabelDraft(event.target.value)}
                        maxLength={120}
                        placeholder="Community label"
                        className="h-8 text-xs"
                      />
                      <Button
                        size="sm"
                        onClick={() => {
                          if (!selectedCommunity.communityKey) return;
                          const nextLabel = communityLabelDraft.trim();
                          if (!nextLabel || nextLabel === selectedCommunity.communityLabel) return;
                          saveCommunityLabel.mutate({
                            communityKey: selectedCommunity.communityKey,
                            label: nextLabel,
                          });
                        }}
                        disabled={
                          saveCommunityLabel.isPending ||
                          communityLabelDraft.trim().length === 0 ||
                          communityLabelDraft.trim() === selectedCommunity.communityLabel
                        }
                      >
                        Save
                      </Button>
                    </div>
                    <div className="graph-detail-meta-grid">
                      <div className="graph-detail-metric">
                        <span>ID</span>
                        <strong>{selectedCommunity.communityId}</strong>
                      </div>
                      <div className="graph-detail-metric">
                        <span>Size</span>
                        <strong>{selectedCommunity.size}</strong>
                      </div>
                      <div className="graph-detail-metric">
                        <span>Embedded</span>
                        <strong>
                          {formatPercent(
                            selectedCommunity.size > 0
                              ? selectedCommunity.embeddedCount / selectedCommunity.size
                              : 0,
                          )}
                        </strong>
                      </div>
                      <div className="graph-detail-metric">
                        <span>Source Density</span>
                        <strong>{selectedCommunity.sourceRefDensity.toFixed(2)}</strong>
                      </div>
                    </div>
                    <div className="graph-community-health-badges">
                      <Badge
                        variant="outline"
                        className={`h-5 text-[11px] ${
                          selectedCommunity.health.dead
                            ? "border-rose-300 text-rose-100"
                            : "border-emerald-300 text-emerald-100"
                        }`}
                      >
                        cold:{selectedCommunity.health.dead ? "yes" : "no"}
                      </Badge>
                      <Badge
                        variant="outline"
                        className={`h-5 text-[11px] ${
                          selectedCommunity.health.stale
                            ? "border-amber-300 text-amber-100"
                            : "border-emerald-300 text-emerald-100"
                        }`}
                      >
                        stale:{selectedCommunity.health.stale ? "yes" : "no"}
                      </Badge>
                      <Badge
                        variant="outline"
                        className={`h-5 text-[11px] ${
                          selectedCommunity.health.thinEvidence
                            ? "border-sky-300 text-sky-100"
                            : "border-emerald-300 text-emerald-100"
                        }`}
                      >
                        thin:{selectedCommunity.health.thinEvidence ? "yes" : "no"}
                      </Badge>
                    </div>
                    <div className="graph-community-summary-grid">
                      <div className="graph-community-summary-item">
                        <span>Type</span>
                        <p>
                          {Object.entries(selectedCommunity.typeCounts)
                            .map(([key, count]) => `${key}:${count}`)
                            .join(" / ") || "-"}
                        </p>
                      </div>
                      <div className="graph-community-summary-item">
                        <span>Status</span>
                        <p>
                          {Object.entries(selectedCommunity.statusCounts)
                            .map(([key, count]) => `${key}:${count}`)
                            .join(" / ") || "-"}
                        </p>
                      </div>
                      <div className="graph-community-summary-item">
                        <span>Compile</span>
                        <p>{selectedCommunity.compileSelectCount}</p>
                      </div>
                      <div className="graph-community-summary-item">
                        <span>State</span>
                        <p>{healthLabel(selectedCommunity)}</p>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="graph-detail-empty">Community data is not available.</div>
                )}
              </section>
            ) : null}
          </aside>
        </div>
      ) : null}

      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Canvas click is for pointer selection clear only */}
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
        onClick={() => {
          if (!dragged.current) {
            setSelectedId(null);
          }
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
            {displayEdgesSource.map((edge) => {
              const source = screenNodeById.get(edge.source);
              const target = screenNodeById.get(edge.target);
              if (!source || !target) return null;
              const strokeWidth =
                edge.edgeKind === "community"
                  ? clamp(edge.weight * 0.6, 1, 6)
                  : Math.max(0.5, edge.weight * 2);
              return (
                <line
                  key={edge.id}
                  x1={source.x}
                  y1={source.y}
                  x2={target.x}
                  y2={target.y}
                  className={`graph-edge ${edge.edgeKind}`}
                  strokeWidth={strokeWidth}
                  opacity={0.4}
                />
              );
            })}
            {viewMode === "community" && showContradictionOverlay
              ? contradictionOverlayEdges.map((edge) => {
                  const source = screenNodeById.get(edge.sourceNodeId);
                  const target = screenNodeById.get(edge.targetNodeId);
                  if (!source || !target) return null;
                  const strokeWidth = clamp(edge.confidence * 4, 1.1, 3.6);
                  const opacity =
                    edge.status === "resolved" || edge.status === "dismissed"
                      ? 0.2
                      : edge.confidenceLabel === "high"
                        ? 0.86
                        : edge.confidenceLabel === "medium"
                          ? 0.62
                          : 0.38;
                  return (
                    <line
                      key={`contradiction-${edge.id}`}
                      x1={source.x}
                      y1={source.y}
                      x2={target.x}
                      y2={target.y}
                      className="graph-edge contradiction"
                      strokeWidth={strokeWidth}
                      opacity={opacity}
                    >
                      <title>
                        {`pair=${edge.pairKey} confidence=${edge.confidence.toFixed(3)} (${edge.confidenceLabel}) status=${edge.status}${edge.evidencePreview ? ` evidence=${edge.evidencePreview}` : ""}`}
                      </title>
                    </line>
                  );
                })
              : null}
          </g>
          {/* Nodes */}
          <g>
            {nodes.map((node) => {
              const isSelected = selectedId === node.id;
              const isEmbedded = node.embedded;
              const screenNode = screenNodeById.get(node.id);
              if (!screenNode) return null;
              const landscapeClasses = nodeLandscapeClass(
                node,
                viewMode,
                landscapeByCommunityKey,
                trajectoryHighlightKnowledgeIds,
                sandboxHighlightCommunityKeys,
              ).join(" ");
              const baseStroke = isSelected
                ? "#fff"
                : isEmbedded
                  ? "rgba(255, 255, 255, 0.12)"
                  : "rgba(251, 191, 36, 0.88)";

              if (node.kind === "source") {
                const halfSize = sourceNodeHalfSize(node);
                return (
                  <rect
                    key={`source-${node.id}`}
                    x={screenNode.x - halfSize.x}
                    y={screenNode.y - halfSize.y}
                    width={halfSize.x * 2}
                    height={halfSize.y * 2}
                    rx={4}
                    fill={nodeColorForView(node, viewMode)}
                    stroke={baseStroke}
                    strokeWidth={isSelected ? 2.2 : isEmbedded ? 0.8 : 1.2}
                    strokeDasharray={isEmbedded ? undefined : "2.5 2"}
                    opacity={isEmbedded ? 1 : 0.9}
                    className={`graph-node-rect ${landscapeClasses}`}
                    role="button"
                    tabIndex={0}
                    aria-label={`Select ${node.label || node.id}`}
                    onMouseEnter={() => setHoveredId(node.id)}
                    onMouseLeave={() => setHoveredId(null)}
                    onClick={(event) => {
                      event.stopPropagation();
                      setSelectedId(node.id);
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      event.stopPropagation();
                      setSelectedId(node.id);
                    }}
                  />
                );
              }

              return (
                <circle
                  key={`circle-${node.id}`}
                  cx={screenNode.x}
                  cy={screenNode.y}
                  r={6 + node.weight * 4}
                  fill={nodeColorForView(node, viewMode)}
                  stroke={baseStroke}
                  strokeWidth={isSelected ? 2.2 : isEmbedded ? 0.8 : 1.2}
                  strokeDasharray={isEmbedded ? undefined : "2.5 2"}
                  opacity={isEmbedded ? 1 : 0.9}
                  className={`graph-node-circle ${landscapeClasses}`}
                  role="button"
                  tabIndex={0}
                  aria-label={`Select ${node.label || node.id}`}
                  onMouseEnter={() => setHoveredId(node.id)}
                  onMouseLeave={() => setHoveredId(null)}
                  onClick={(event) => {
                    event.stopPropagation();
                    setSelectedId(node.id);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    event.stopPropagation();
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
              const nodeRadius =
                node.kind === "source" ? sourceNodeHalfSize(node).y : 6 + node.weight * 4;
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
