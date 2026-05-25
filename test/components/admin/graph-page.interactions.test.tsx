import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  mockGraphData,
  mockLandscapeData,
  mockLandscapeReviewItems,
  mockLandscapeSnapshotCacheStatus,
  mockNodeDetail,
  mockReplayComparisonData,
  mockReplayData,
  mockTrajectoryData,
} from "../../fixtures/graph-page-fixtures";
import { GraphPage } from "../../../web/src/modules/admin/components/graph.page";
import {
  createLandscapeReviewCandidates,
  fetchLandscapeContradictionOverlay,
  fetchGraphNodeDetail,
  fetchGraphSnapshot,
  fetchLandscapeReplayComparison,
  fetchLandscapeReplaySnapshot,
  fetchLandscapeSnapshotCacheStatus,
  fetchLandscapeTrajectory,
  fetchLandscapeReviewItems,
  fetchLandscapeSnapshot,
  materializeLandscapeReviewItems,
  updateGraphCommunityLabel,
  updateLandscapeReviewItemStatus,
} from "../../../web/src/modules/admin/repositories/admin.repository";

// ResizeObserver のモック
class ResizeObserverMock {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}
global.ResizeObserver = ResizeObserverMock as any;

// Repositories API のモック
vi.mock("../../../web/src/modules/admin/repositories/admin.repository", () => ({
  fetchGraphSnapshot: vi.fn(),
  fetchLandscapeSnapshot: vi.fn(),
  fetchLandscapeSnapshotCacheStatus: vi.fn(),
  fetchLandscapeReplayComparison: vi.fn(),
  fetchLandscapeContradictionOverlay: vi.fn(),
  fetchLandscapeTrajectory: vi.fn(),
  fetchLandscapeReplaySnapshot: vi.fn(),
  fetchLandscapeReviewItems: vi.fn(),
  createLandscapeReviewCandidates: vi.fn(),
  materializeLandscapeReviewItems: vi.fn(),
  fetchGraphNodeDetail: vi.fn(),
  updateLandscapeReviewItemStatus: vi.fn(),
  updateGraphCommunityLabel: vi.fn(),
}));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
    },
  },
});

describe("GraphPage", () => {
  beforeEach(() => {
    queryClient.clear();
    vi.clearAllMocks();
    vi.mocked(fetchLandscapeSnapshot).mockResolvedValue(mockLandscapeData);
    vi.mocked(fetchLandscapeSnapshotCacheStatus).mockResolvedValue(
      mockLandscapeSnapshotCacheStatus,
    );
    vi.mocked(fetchLandscapeReplaySnapshot).mockResolvedValue(mockReplayData);
    vi.mocked(fetchLandscapeReplayComparison).mockResolvedValue(mockReplayComparisonData);
    vi.mocked(fetchLandscapeContradictionOverlay).mockResolvedValue({
      count: 1,
      items: [
        {
          reviewItemId: "review-item-3",
          leftKnowledgeId: "k-left",
          rightKnowledgeId: "k-right",
          pairKey: "k-left::k-right",
          confidence: 0.72,
          confidenceLabel: "medium",
          status: "pending",
          evidence: ["pair=k-left::k-right"],
          communityKey: "a".repeat(64),
          createdAt: "2026-05-24T00:00:00.000Z",
          updatedAt: "2026-05-24T00:00:00.000Z",
        },
      ],
    });
    vi.mocked(fetchLandscapeReviewItems).mockResolvedValue(mockLandscapeReviewItems);
    vi.mocked(fetchLandscapeTrajectory).mockResolvedValue(mockTrajectoryData);
    vi.mocked(createLandscapeReviewCandidates).mockResolvedValue({
      dryRun: false,
      processedCount: 1,
      createdCount: 1,
      existingCount: 0,
      missingIds: [],
      items: [
        {
          reviewItemId: "review-item-1",
          reason: "baseline_wrong",
          proposedAction: "review_wrong",
          candidateType: "rule",
          candidateKey: "landscape-review-item:review-item-1:baseline_wrong:hash",
          targetKey: "landscape-review-item:review-item-1:baseline_wrong:hash",
          targetStateId: "target-1",
          findCandidateResultId: "candidate-1",
          linkId: "link-1",
          linkStatus: "draft_created",
          draftLinked: true,
        },
      ],
    });
    vi.mocked(fetchGraphNodeDetail).mockResolvedValue(null);
    vi.mocked(materializeLandscapeReviewItems).mockResolvedValue({
      dryRun: false,
      generatedAt: "2026-05-24T00:00:00.000Z",
      candidateCount: 4,
      insertedCount: 1,
      existingCount: 1,
      skippedCount: 0,
      items: mockLandscapeReviewItems.items,
      candidates: [],
    });
    vi.mocked(updateLandscapeReviewItemStatus).mockResolvedValue({
      ...mockLandscapeReviewItems.items[0],
      status: "resolved",
      resolvedAt: "2026-05-24T01:00:00.000Z",
    });
  });

  it("supports community supernode mode and label save", async () => {
    vi.mocked(fetchGraphSnapshot).mockResolvedValue({
      ...mockGraphData,
      nodes: [],
      edges: [],
      communities: [
        {
          communityId: "community:1",
          communityKey: "b".repeat(64),
          communityLabel: "Legacy Label",
          communityRank: 1,
          size: 3,
          typeCounts: { rule: 2, procedure: 1 },
          statusCounts: { active: 3 },
          embeddedCount: 2,
          compileSelectCount: 4,
          staleNodeCount: 1,
          sourceRefCount: 2,
          sourceRefDensity: 0.66,
          health: { dead: false, stale: false, thinEvidence: false },
        },
      ],
      supernodes: [
        {
          id: "community:1",
          label: "Legacy Label",
          communityKey: "b".repeat(64),
          size: 3,
          communityRank: 1,
          health: { dead: false, stale: false, thinEvidence: false },
        },
      ],
      superedges: [],
      stats: {
        ...mockGraphData.stats,
        communityCount: 1,
        largestCommunitySize: 3,
        orphanNodeCount: 0,
      },
    });
    vi.mocked(updateGraphCommunityLabel).mockResolvedValue({
      communityKey: "b".repeat(64),
      label: "New Label",
      note: null,
      updatedAt: "2026-05-23T00:00:00.000Z",
    });

    render(
      <QueryClientProvider client={queryClient}>
        <GraphPage />
      </QueryClientProvider>,
    );

    await screen.findByText("Knowledge Graph");
    const selects = screen.getAllByRole("combobox");
    const viewModeSelect = selects[1];
    fireEvent.change(viewModeSelect, { target: { value: "community" } });

    const displaySelect = await screen.findByDisplayValue("Detail");
    fireEvent.change(displaySelect, { target: { value: "supernode" } });

    expect(fetchGraphSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({
        view: "community",
        communityDisplay: "supernode",
      }),
    );
    expect(fetchLandscapeSnapshot).toHaveBeenCalledWith({
      windowDays: 30,
      limit: 1000,
      status: "current",
      relationAxes: ["session", "project", "source"],
    });
    expect(fetchLandscapeReplaySnapshot).toHaveBeenCalledWith({
      windowDays: 30,
      limit: 500,
      landscapeLimit: 1000,
      landscapeStatus: "current",
      relationAxes: ["session", "project", "source"],
      includeRuns: false,
    });

    const supernodeButton = await screen.findByRole("button", {
      name: "Select Legacy Label",
    });
    fireEvent.click(supernodeButton);

    const input = await screen.findByPlaceholderText("Community label");
    fireEvent.change(input, { target: { value: "New Label" } });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(updateGraphCommunityLabel).toHaveBeenCalledWith({
        communityKey: "b".repeat(64),
        label: "New Label",
      });
    });
  });

  it("supports evidence view with source node detail and without knowledge detail fetch", async () => {
    vi.mocked(fetchGraphSnapshot).mockImplementation(async (input) => {
      const view =
        typeof input === "number" || input === undefined ? "relation" : (input.view ?? "relation");
      if (view !== "evidence") {
        return mockGraphData;
      }
      return {
        ...mockGraphData,
        nodes: [
          ...mockGraphData.nodes,
          {
            id: "source:s1",
            label: "Evidence Source",
            kind: "source",
            group: "source",
            weight: 0.8,
            status: "active",
            embedded: true,
            sourceId: "s1",
            sourceKind: "wiki",
            sourceUri: "file:///evidence/source-1.md",
            sourceTitle: "Evidence Source",
            linkedKnowledgeCount: 1,
          },
        ],
        edges: [
          {
            id: "evidence:n1:s1",
            source: "knowledge:n1",
            target: "source:s1",
            relationType: "linked_source",
            edgeKind: "evidence",
            relationAxis: "evidence",
            derived: false,
            weight: 0.7,
          },
        ],
        stats: {
          ...mockGraphData.stats,
          sourceNodeCount: 1,
          evidenceEdgeCount: 1,
          evidenceLinkedKnowledgeCount: 1,
          evidenceUnlinkedKnowledgeCount: 1,
          visibleKnowledgeCount: 2,
        },
      };
    });

    render(
      <QueryClientProvider client={queryClient}>
        <GraphPage />
      </QueryClientProvider>,
    );

    await screen.findByText("Node 1");
    const selects = screen.getAllByRole("combobox");
    const viewModeSelect = selects[1];
    fireEvent.change(viewModeSelect, { target: { value: "evidence" } });

    expect(fetchGraphSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({
        view: "evidence",
        sourceNodeLimit: 800,
      }),
    );
    expect(await screen.findByText("Source Nodes")).toBeInTheDocument();
    expect(screen.getByText("Evidence Edges")).toBeInTheDocument();
    expect(screen.getByText("Unlinked")).toBeInTheDocument();

    const sourceNodeButton = await screen.findByRole("button", {
      name: "Select Evidence Source",
    });
    fireEvent.click(sourceNodeButton);

    expect(await screen.findByText("file:///evidence/source-1.md")).toBeInTheDocument();
    expect(screen.getByText("Linked Knowledge")).toBeInTheDocument();
    expect(fetchGraphNodeDetail).not.toHaveBeenCalled();
  });

  it("handles relation axis toggling in relation view mode", async () => {
    vi.mocked(fetchGraphSnapshot).mockResolvedValue(mockGraphData);

    render(
      <QueryClientProvider client={queryClient}>
        <GraphPage />
      </QueryClientProvider>,
    );

    await screen.findByText("Node 1");

    // "relation" モードで軸チェックボックスが存在することを確認
    const sessionCheckbox = screen.getByLabelText("Session");
    const projectCheckbox = screen.getByLabelText("Project");
    const sourceCheckbox = screen.getByLabelText("Source");

    expect(sessionCheckbox).toBeChecked();

    // チェックボックスをクリックしてトグル
    fireEvent.click(sessionCheckbox);
    expect(sessionCheckbox).not.toBeChecked();

    // 最後の1個はトグルオフできないことを確認する
    fireEvent.click(projectCheckbox);
    fireEvent.click(sourceCheckbox); // これで source だけがチェック状態に
    fireEvent.click(sourceCheckbox); // トグルオフしようとしても prev.length === 1 で維持されるはず
    expect(sourceCheckbox).toBeChecked();
  });

  it("handles node interaction, detail fetching, and failure fallbacks", async () => {
    vi.mocked(fetchGraphSnapshot).mockResolvedValue(mockGraphData);
    vi.mocked(fetchGraphNodeDetail).mockImplementation(async (id) => {
      if (id === "knowledge:n2" || id === "n2") {
        throw new Error("API Error");
      }
      return mockNodeDetail;
    });

    render(
      <QueryClientProvider client={queryClient}>
        <GraphPage />
      </QueryClientProvider>,
    );

    await screen.findByText("Node 1");

    const circles = screen.getAllByRole("button", { name: /Select/i });
    const node1Circle = circles[0];

    // 1. マウスホバーによる hoveredId のテスト
    fireEvent.mouseEnter(node1Circle);
    fireEvent.mouseLeave(node1Circle);

    // 2. クリックによる詳細フェッチと表示
    fireEvent.click(node1Circle);

    // 詳細の表示を待つ
    expect(await screen.findByText("This is a preview of Node 1")).toBeInTheDocument();
    expect(screen.getByText("90")).toBeInTheDocument(); // confidence
    expect(screen.getByText("80")).toBeInTheDocument(); // importance

    // 3. キーボード操作でのノード選択
    fireEvent.keyDown(circles[1], { key: "Enter" });

    // 4. フェッチ失敗時のフォールバック (キャッシュのないNode 2を選択しフェッチ失敗させる)
    const node2Circle = circles[1];
    fireEvent.click(node2Circle);
    expect(await screen.findByText("Detail fetch failed. Showing graph data.")).toBeInTheDocument();
  });

  it("supports canvas dragging, zooming, double-clicking, and resizing", async () => {
    vi.mocked(fetchGraphSnapshot).mockResolvedValue(mockGraphData);

    render(
      <QueryClientProvider client={queryClient}>
        <GraphPage />
      </QueryClientProvider>,
    );

    await screen.findByText("Node 1");

    const img = screen.getByRole("img", { name: "Knowledge graph visualization" });
    const canvas = img.parentElement;
    expect(canvas).not.toBeNull();
    if (!canvas) throw new Error("Canvas element not found");

    // 1. ドラッグ操作 (MouseDown -> MouseMove -> MouseUp)
    fireEvent.mouseDown(canvas, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(canvas, { clientX: 150, clientY: 150 });
    fireEvent.mouseUp(canvas);

    // 2. ホイールズーム操作
    fireEvent.wheel(canvas, { deltaY: -100, clientX: 200, clientY: 200 });
    fireEvent.wheel(canvas, { deltaY: 200, clientX: 200, clientY: 200 });

    // 3. ダブルクリックによるフィットリセット
    fireEvent.doubleClick(canvas);

    // 4. ウィンドウのリサイズイベント
    fireEvent(window, new Event("resize"));
  });

  it("renders empty state when there are no nodes", async () => {
    vi.mocked(fetchGraphSnapshot).mockResolvedValue({
      nodes: [],
      edges: [],
      communities: [],
      supernodes: [],
      superedges: [],
      stats: {
        visibleKnowledgeCount: 0,
        totalKnowledgeCount: 0,
        embeddedKnowledgeCount: 0,
        semanticEdgeCount: 0,
        sessionEdgeCount: 0,
        projectEdgeCount: 0,
        sourceEdgeCount: 0,
        sourceNodeCount: 0,
        evidenceEdgeCount: 0,
        evidenceLinkedKnowledgeCount: 0,
        evidenceUnlinkedKnowledgeCount: 0,
        truncatedSourceNodeCount: 0,
        relationEdgeCount: 0,
        sourceRefCount: 0,
        communityCount: 0,
        largestCommunitySize: 0,
        orphanNodeCount: 0,
        deadCommunityCount: 0,
        staleCommunityCount: 0,
        thinEvidenceCommunityCount: 0,
      },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <GraphPage />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("表示できるノードがありません")).toBeInTheDocument();
  });

  it("supports edge cases like 1 node, and zero edges in layout calculation", async () => {
    // 1ノード、エッジなし
    vi.mocked(fetchGraphSnapshot).mockResolvedValue({
      nodes: [
        {
          id: "knowledge:n1",
          label: "Node 1",
          kind: "knowledge",
          group: "rule",
          weight: 1,
          status: "active",
          embedded: true,
        },
      ],
      edges: [],
      communities: [],
      supernodes: [],
      superedges: [],
      stats: {
        visibleKnowledgeCount: 1,
        totalKnowledgeCount: 1,
        embeddedKnowledgeCount: 1,
        semanticEdgeCount: 0,
        sessionEdgeCount: 0,
        projectEdgeCount: 0,
        sourceEdgeCount: 0,
        sourceNodeCount: 0,
        evidenceEdgeCount: 0,
        evidenceLinkedKnowledgeCount: 0,
        evidenceUnlinkedKnowledgeCount: 1,
        truncatedSourceNodeCount: 0,
        relationEdgeCount: 0,
        sourceRefCount: 0,
        communityCount: 1,
        largestCommunitySize: 1,
        orphanNodeCount: 1,
        deadCommunityCount: 0,
        staleCommunityCount: 0,
        thinEvidenceCommunityCount: 0,
      },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <GraphPage />
      </QueryClientProvider>,
    );

    await screen.findByText("Node 1");
    expect(screen.getByText("Nodes")).toBeInTheDocument();
  });
});
