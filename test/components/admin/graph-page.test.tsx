import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GraphPage } from "../../../web/src/modules/admin/components/graph.page";
import {
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
} from "../../../web/src/modules/admin/repositories/admin.repository";
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

  it("community view 以外では landscape fetch を行わない", async () => {
    vi.mocked(fetchGraphSnapshot).mockResolvedValue(mockGraphData);

    render(
      <QueryClientProvider client={queryClient}>
        <GraphPage />
      </QueryClientProvider>,
    );

    await screen.findByText("Node 1");
    expect(fetchLandscapeSnapshot).not.toHaveBeenCalled();
    expect(fetchLandscapeReplaySnapshot).not.toHaveBeenCalled();
    expect(fetchLandscapeReplayComparison).not.toHaveBeenCalled();
    expect(fetchLandscapeReviewItems).not.toHaveBeenCalled();

    const selects = screen.getAllByRole("combobox");
    const viewModeSelect = selects[1];
    fireEvent.change(viewModeSelect, { target: { value: "semantic" } });
    expect(fetchLandscapeSnapshot).not.toHaveBeenCalled();
    expect(fetchLandscapeReplaySnapshot).not.toHaveBeenCalled();
    expect(fetchLandscapeReplayComparison).not.toHaveBeenCalled();
    expect(fetchLandscapeReviewItems).not.toHaveBeenCalled();

    fireEvent.change(viewModeSelect, { target: { value: "community" } });
    await waitFor(() => {
      expect(fetchLandscapeSnapshot).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(fetchLandscapeReplaySnapshot).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(fetchLandscapeReplayComparison).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(fetchLandscapeReviewItems).toHaveBeenCalledTimes(1);
    });
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
    vi.mocked(fetchLandscapeSnapshot).mockResolvedValue({
      ...mockLandscapeData,
      stats: {
        ...mockLandscapeData.stats,
        totalCommunities: 1,
        activeCommunities: 1,
        selectedCommunities: 1,
        strongAttractorCount: 1,
      },
      communities: [
        {
          communityId: "community:1",
          communityKey: "a".repeat(64),
          communityLabel: "Core Reliability",
          communityRank: 1,
          size: 2,
          memberCounts: {
            active: 1,
            draft: 1,
            deprecated: 0,
            rule: 1,
            procedure: 1,
            embedded: 1,
          },
          selection: {
            selectedItemCountWindow: 6,
            selectedRunCountWindow: 4,
            cumulativeCompileSelectCount: 6,
            zeroUseActiveCount: 0,
            zeroUseActiveRatio: 0,
          },
          feedback: {
            usedCountWindow: 4,
            notUsedCountWindow: 1,
            offTopicCountWindow: 1,
            wrongCountWindow: 0,
            feedbackCountWindow: 6,
            usedRate: 0.667,
            notUsedRate: 0.167,
            offTopicRate: 0.167,
            wrongRate: 0,
            feedbackConfidence: "low",
          },
          quality: {
            avgImportance: 80,
            avgConfidence: 75,
            avgDynamicScore: 20,
            sourceRefCount: 2,
            sourceRefDensity: 1,
            avgFreshnessFactor: 0.9,
            avgStalenessFactor: 0.1,
          },
          scores: {
            activity: 6,
            attractorScore: 2.8,
            negativeScore: 0.7,
            reachabilityRiskScore: 0.1,
          },
          classification: {
            primary: "strong_attractor",
            flags: [],
            confidence: "medium",
            reason: "used ratio is high",
          },
          recommendedActions: ["keep"],
          representativeKnowledgeIds: ["n1", "n2"],
        },
      ],
      risks: [],
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
    const circles = await screen.findAllByRole("button", { name: /Select/i });
    fireEvent.click(circles[0]);
    await screen.findByText("Core Reliability");

    expect(fetchGraphSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({
        view: "community",
        communityDisplay: "detail",
        relationAxes: ["session", "project", "source"],
      }),
    );
    expect(fetchLandscapeSnapshot).toHaveBeenCalledWith({
      windowDays: 30,
      limit: 1000,
      status: "current",
      relationAxes: ["session", "project", "source"],
    });
    expect(fetchLandscapeSnapshotCacheStatus).toHaveBeenCalled();
    expect(fetchLandscapeReplaySnapshot).toHaveBeenCalledWith({
      windowDays: 30,
      limit: 500,
      landscapeLimit: 1000,
      landscapeStatus: "current",
      relationAxes: ["session", "project", "source"],
      includeRuns: false,
    });
    expect(await screen.findByText(/enabled ttl=300s/i)).toBeInTheDocument();
    expect(fetchLandscapeReplayComparison).toHaveBeenCalledWith({
      windowDays: 30,
      limit: 25,
      runStatus: "all",
      currentLimit: 12,
      includeRuns: true,
    });
    expect(fetchLandscapeReviewItems).toHaveBeenCalledWith({
      status: "pending",
      source: "all",
      reason: "all",
      proposedAction: "all",
      priorityMin: 0,
      limit: 200,
    });
    expect(await screen.findByText("Communities")).toBeInTheDocument();
    expect(screen.getByText("Largest")).toBeInTheDocument();
    expect(screen.getByText("Orphans")).toBeInTheDocument();
    expect(screen.getByText("Cold")).toBeInTheDocument();
    expect(screen.getByText("Thin")).toBeInTheDocument();
    expect(screen.getByText("Community Summary")).toBeInTheDocument();
    expect(screen.getByText("Dynamic Health Card")).toBeInTheDocument();
    expect(screen.getByText("Replay Health")).toBeInTheDocument();
    expect(screen.getByText("Replay Used")).toBeInTheDocument();
    expect(screen.getByText("Replay Review")).toBeInTheDocument();
    expect(screen.getByText("Action Queue")).toBeInTheDocument();
    expect(screen.getByText("Contradiction Review")).toBeInTheDocument();
    expect(screen.getByText("Candidate Only")).toBeInTheDocument();
    expect(screen.getByText("Risky Runs")).toBeInTheDocument();
    expect(screen.getByText("k-persisted-1")).toBeInTheDocument();
    expect(screen.getAllByText("k-lost").length).toBeGreaterThan(0);
    expect(screen.getByText("Replay risky graph UI task")).toBeInTheDocument();
    expect(screen.getByText("Top Facet Risks")).toBeInTheDocument();
    expect(screen.getAllByText("Strong Attractor").length).toBeGreaterThan(0);
  });

  it("creates persisted review items and updates status from replay review card", async () => {
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
          health: { dead: false, stale: false, thinEvidence: false },
        },
      ],
    });

    render(
      <QueryClientProvider client={queryClient}>
        <GraphPage />
      </QueryClientProvider>,
    );

    await screen.findByText("Node 1");
    const selects = screen.getAllByRole("combobox");
    fireEvent.change(selects[1], { target: { value: "community" } });
    const circles = await screen.findAllByRole("button", { name: /Select/i });
    fireEvent.click(circles[0]);
    await screen.findByText("Replay Review");
    expect(
      screen.getByText("Select a run to compare baseline/current/sandbox."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Sandbox Changed IDs")).not.toBeInTheDocument();

    const createCandidateButton = await screen.findByRole("button", {
      name: "Create Candidate Drafts",
    });
    fireEvent.click(createCandidateButton);
    await waitFor(() => {
      expect(createLandscapeReviewCandidates).toHaveBeenCalled();
    });
    const [candidateInput] = vi.mocked(createLandscapeReviewCandidates).mock.calls[0] ?? [];
    expect(candidateInput).toEqual({
      status: "pending",
      limit: 20,
      dryRun: false,
    });

    const createReviewItemsButton = await screen.findByRole("button", {
      name: "Create Review Items",
    });
    fireEvent.click(createReviewItemsButton);
    await waitFor(() => {
      expect(materializeLandscapeReviewItems).toHaveBeenCalled();
    });
    const [materializeInput] = vi.mocked(materializeLandscapeReviewItems).mock.calls[0] ?? [];
    expect(materializeInput).toEqual({
      dryRun: false,
      windowDays: 30,
      limit: 25,
      runStatus: "all",
      currentLimit: 12,
      landscapeLimit: 1000,
      landscapeStatus: "current",
      relationAxes: ["session", "project", "source"],
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
    });

    expect(await screen.findByText("Draft linked")).toBeInTheDocument();
    expect(await screen.findByText(/warning: promotion gate review required/i)).toBeInTheDocument();
    expect(await screen.findByText("k-left vs k-right")).toBeInTheDocument();
    const candidateLinks = await screen.findAllByRole("link", { name: "View Candidate" });
    expect(candidateLinks[0]).toHaveAttribute("href", "/candidates?targetStateId=target-1");

    const trajectoryButtons = await screen.findAllByRole("button", { name: "View Trajectory" });
    fireEvent.click(trajectoryButtons[0]);
    await waitFor(() => {
      expect(fetchLandscapeTrajectory).toHaveBeenCalledWith({
        runId: "run-1",
        includeCandidates: true,
        limit: 200,
      });
    });
    expect(await screen.findByText("trace unavailable")).toBeInTheDocument();

    const sandboxButtons = await screen.findAllByRole("button", { name: "Compare Sandbox" });
    fireEvent.click(sandboxButtons[0]);
    expect(await screen.findByText("Sandbox Comparison")).toBeInTheDocument();
    expect(
      screen.queryByText("Select a run to compare baseline/current/sandbox."),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/Removed \(/)).toBeInTheDocument();
    expect(screen.getByText(/Added \(/)).toBeInTheDocument();
    expect(screen.getByText(/Retained \(/)).toBeInTheDocument();
    expect(screen.getByLabelText("sandbox-run-selector")).toBeInTheDocument();
    const sandboxDiffFilter = screen.getByLabelText("sandbox-diff-filter");
    fireEvent.change(sandboxDiffFilter, { target: { value: "added" } });
    expect(await screen.findByText("Filtered IDs")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Focus Node" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Candidate Search" })).toBeInTheDocument();

    const resolveButtons = await screen.findAllByRole("button", { name: "Resolve" });
    fireEvent.click(resolveButtons[0]);
    await waitFor(() => {
      expect(updateLandscapeReviewItemStatus).toHaveBeenCalledWith("review-item-1", {
        status: "resolved",
      });
    });

    const dismissButtons = await screen.findAllByRole("button", { name: "Dismiss" });
    fireEvent.click(dismissButtons[0]);
    await waitFor(() => {
      expect(updateLandscapeReviewItemStatus).toHaveBeenCalledWith("review-item-1", {
        status: "dismissed",
      });
    });
  });
});
