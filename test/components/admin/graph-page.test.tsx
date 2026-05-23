import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GraphPage } from "../../../web/src/modules/admin/components/graph.page";
import {
  type GraphNodeDetail,
  type GraphSnapshot,
  fetchGraphNodeDetail,
  fetchGraphSnapshot,
  updateGraphCommunityLabel,
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
  fetchGraphNodeDetail: vi.fn(),
  updateGraphCommunityLabel: vi.fn(),
}));

const mockGraphData: GraphSnapshot = {
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
    {
      id: "knowledge:n2",
      label: "Node 2",
      kind: "knowledge",
      group: "procedure",
      weight: 0.5,
      status: "draft",
      embedded: false,
    },
  ],
  edges: [
    {
      id: "e1",
      source: "knowledge:n1",
      target: "knowledge:n2",
      relationType: "semantic",
      edgeKind: "semantic",
      relationAxis: "semantic",
      derived: false,
      weight: 0.8,
    },
  ],
  communities: [],
  supernodes: [],
  superedges: [],
  stats: {
    visibleKnowledgeCount: 2,
    totalKnowledgeCount: 2,
    embeddedKnowledgeCount: 1,
    semanticEdgeCount: 1,
    sessionEdgeCount: 0,
    projectEdgeCount: 0,
    sourceEdgeCount: 0,
    sourceNodeCount: 0,
    evidenceEdgeCount: 0,
    evidenceLinkedKnowledgeCount: 0,
    evidenceUnlinkedKnowledgeCount: 2,
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
};

const mockNodeDetail: GraphNodeDetail = {
  id: "knowledge:n1",
  label: "Node 1",
  kind: "knowledge",
  group: "rule",
  detail: "Detail of Node 1",
  weight: 1,
  status: "active",
  confidence: 90,
  importance: 80,
  bodyPreview: "This is a preview of Node 1",
  embedded: true,
};

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
  });

  it("renders graph visualization and statistics correctly", async () => {
    vi.mocked(fetchGraphSnapshot).mockResolvedValue(mockGraphData);

    render(
      <QueryClientProvider client={queryClient}>
        <GraphPage />
      </QueryClientProvider>,
    );

    // ロード完了後のノード数とエッジ数の統計を確認
    await screen.findByText("Node 1");
    expect(screen.getByText("Nodes")).toBeInTheDocument();
    expect(screen.getByText("Edges")).toBeInTheDocument();

    // SVG 内の円要素 (Node 1, Node 2) がレンダリングされているか確認
    const circles = screen.getAllByRole("button", { name: /Select/i });
    expect(circles.length).toBe(2);
  });

  it("handles status filter and view mode changes", async () => {
    vi.mocked(fetchGraphSnapshot).mockResolvedValue(mockGraphData);

    render(
      <QueryClientProvider client={queryClient}>
        <GraphPage />
      </QueryClientProvider>,
    );

    await screen.findByText("Node 1");

    // ステータスフィルターとビューモードのセレクトボックスを取得
    const selects = screen.getAllByRole("combobox");
    const statusFilterSelect = selects[0];
    const viewModeSelect = selects[1];

    fireEvent.change(statusFilterSelect, { target: { value: "draft" } });
    expect(fetchGraphSnapshot).toHaveBeenCalled();

    fireEvent.change(viewModeSelect, { target: { value: "semantic" } });
    expect(fetchGraphSnapshot).toHaveBeenCalled();
  });

  it("handles community view with relation axes and community stats", async () => {
    vi.mocked(fetchGraphSnapshot).mockResolvedValue({
      ...mockGraphData,
      nodes: [
        {
          id: "knowledge:n1",
          label: "Node 1",
          kind: "knowledge",
          group: "rule",
          weight: 1,
          status: "active",
          embedded: true,
          communityId: "community:1",
          communityKey: "a".repeat(64),
          communityLabel: "Core Reliability",
          communityRank: 1,
          communitySize: 2,
        },
        {
          id: "knowledge:n2",
          label: "Node 2",
          kind: "knowledge",
          group: "procedure",
          weight: 0.5,
          status: "draft",
          embedded: false,
          communityId: "community:1",
          communityKey: "a".repeat(64),
          communityLabel: "Core Reliability",
          communityRank: 1,
          communitySize: 2,
        },
      ],
      communities: [
        {
          communityId: "community:1",
          communityKey: "a".repeat(64),
          communityLabel: "Core Reliability",
          communityRank: 1,
          size: 2,
          typeCounts: { rule: 1, procedure: 1 },
          statusCounts: { active: 1, draft: 1 },
          embeddedCount: 1,
          compileSelectCount: 0,
          staleNodeCount: 0,
          sourceRefCount: 1,
          sourceRefDensity: 0.5,
          health: { dead: true, stale: false, thinEvidence: true },
        },
      ],
      stats: {
        ...mockGraphData.stats,
        communityCount: 1,
        largestCommunitySize: 2,
        orphanNodeCount: 0,
        deadCommunityCount: 1,
        staleCommunityCount: 0,
        thinEvidenceCommunityCount: 1,
      },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <GraphPage />
      </QueryClientProvider>,
    );

    await screen.findByText("Node 1");
    const selects = screen.getAllByRole("combobox");
    const viewModeSelect = selects[1];
    fireEvent.change(viewModeSelect, { target: { value: "community" } });

    expect(fetchGraphSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({
        view: "community",
        communityDisplay: "detail",
        relationAxes: ["session", "project", "source"],
      }),
    );
    expect(await screen.findByText("Communities")).toBeInTheDocument();
    expect(screen.getByText("Largest")).toBeInTheDocument();
    expect(screen.getByText("Orphans")).toBeInTheDocument();
    expect(screen.getByText("Cold")).toBeInTheDocument();
    expect(screen.getByText("Thin")).toBeInTheDocument();
    expect(screen.getByText("Community Summary")).toBeInTheDocument();
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

    await screen.findByText("Node Detail");
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
