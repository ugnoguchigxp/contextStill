import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CandidatesPage } from "../../../web/src/modules/admin/components/candidates.page";

// 外部APIおよびreact-query、react-routerのモック
vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual("@tanstack/react-query");
  return {
    ...actual,
    useQuery: vi.fn(),
  };
});

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...props }: any) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("../../../web/src/modules/admin/repositories/admin.repository", () => ({
  fetchCandidateItems: vi.fn(),
}));

const queryClient = new QueryClient();

// リッチなモックデータ
const mockCandidateItems = [
  {
    id: "cand-2",
    targetKind: "knowledge_candidate",
    targetKey: "candidate-vibe-abc",
    outcome: "ready_not_finalized",
    candidateIndex: 1,
    original: {
      title: "Vibe Memory Guideline Candidate",
      body: "Use quick status badges in UI layouts.",
    },
    cover: null,
    knowledge: null,
    diff: {
      originalToCover: {
        bodySimilarity: 0.5,
        summary: ["Low overlap"],
      },
    },
    landscapeWarning: {
      source: "landscape_review_item",
      linkId: "link-1",
      reviewItemId: "review-item-1",
      reason: "promotion_gate_review",
      evidence: ["promotion gate review required"],
      linkStatus: "review_required",
      requiresManualApproval: true,
      warningReason: "promotion_gate_review",
    },
    latestUpdatedAt: "invalid-date-format",
    targetStateId: "state-456",
    sourceUri: "agent://candidate/candidate-vibe-abc",
    finalizeSourceUri: "",
  },
  {
    id: "cand-3",
    targetKind: "knowledge_candidate",
    targetKey: "candidate-rejected",
    outcome: "rejected",
    candidateIndex: 2,
    original: {
      title: "Rejected Candidate",
      body: "Candidate that needs rejection review.",
    },
    cover: {
      status: "insufficient",
      stage: "source_support",
      reason: "rule_body_not_actionable",
      importance: null,
      confidence: null,
      title: null,
      body: null,
      type: null,
      referencesCount: 0,
      duplicateRefsCount: 0,
      toolEventsCount: 0,
    },
    knowledge: null,
    diff: {
      originalToCover: null,
    },
    landscapeWarning: null,
    latestUpdatedAt: "2026-05-20T08:00:00.000Z",
    targetStateId: "state-789",
    sourceUri: "agent://candidate/candidate-rejected",
    finalizeSourceUri: "cover-evidence-result://cand-3",
  },
];

const mockStats = {
  total: 2,
  stored: 0,
  readyNotFinalized: 1,
  rejected: 1,
  retryable: 0,
  retainedFailure: 0,
  targetPending: 0,
  candidateOnly: 0,
};

describe("CandidatesPage", () => {
  const mockRefetch = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockRefetch.mockResolvedValue({} as any);
    window.history.replaceState({}, "", "/candidates");

    vi.mocked(useQuery).mockReturnValue({
      data: {
        items: mockCandidateItems,
        stats: mockStats,
        totalPages: 2,
      },
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: mockRefetch,
    } as any);
  });

  it("renders candidates list, headers, stats and badges correctly", () => {
    render(
      <QueryClientProvider client={queryClient}>
        <CandidatesPage />
      </QueryClientProvider>,
    );

    // 検索窓とセレクトボックスの存在確認
    expect(screen.getByPlaceholderText("Search source / candidate / evidence")).toBeInTheDocument();

    // アイテムデータの描画確認
    expect(screen.getAllByText("Vibe Memory Guideline Candidate").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Rejected Candidate").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("candidate-vibe-abc").length).toBeGreaterThanOrEqual(1);

    // Coverage & Outcome バッジの検証
    expect(screen.getByText("no cover result")).toBeInTheDocument();
    expect(screen.getAllByText("Ready to store").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("warning")).toBeInTheDocument();

    // Stats フッターの検証
    expect(screen.getByText(/active 2 \| ready 1 \| failed 0 \| rejected 1/)).toBeInTheDocument();
    expect(screen.queryByText("Premium再評価")).not.toBeInTheDocument();
  });

  it("reads targetStateId from query and shows active filter", () => {
    window.history.replaceState({}, "", "/candidates?targetStateId=state-999");
    render(
      <QueryClientProvider client={queryClient}>
        <CandidatesPage />
      </QueryClientProvider>,
    );

    expect(screen.getByText("targetStateId: state-999")).toBeInTheDocument();

    const latestCall = vi.mocked(useQuery).mock.calls.at(-1)?.[0] as
      | { queryKey?: unknown[] }
      | undefined;
    const latestQueryState = latestCall?.queryKey?.[1] as Record<string, unknown> | undefined;
    expect(latestQueryState?.targetStateIdFilter).toBe("state-999");
  });

  it("handles filtering elements and text queries interactively", () => {
    render(
      <QueryClientProvider client={queryClient}>
        <CandidatesPage />
      </QueryClientProvider>,
    );

    // 1. 検索テキストの変更
    const searchInput = screen.getByPlaceholderText("Search source / candidate / evidence");
    fireEvent.change(searchInput, { target: { value: "architecture" } });

    // 2. target-kind セレクトボックスの変更
    const targetKindSelect = screen.getByLabelText("target-kind");
    expect(targetKindSelect).toHaveValue("knowledge_candidate");
    fireEvent.change(targetKindSelect, { target: { value: "wiki_file" } });

    // 3. 作業レーンの変更
    fireEvent.click(screen.getByRole("button", { name: /Failed/ }));

    // useQuery が正しく更新されたパラメータで動くためのトリガー確認
    expect(useQuery).toHaveBeenCalled();
  });

  it("passes TanStack table sorting state to the candidates query", async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <CandidatesPage />
      </QueryClientProvider>,
    );

    const latestQueryState = () => {
      const latestCall = vi.mocked(useQuery).mock.calls.at(-1)?.[0] as
        | { queryKey?: unknown[] }
        | undefined;
      return latestCall?.queryKey?.[1] as Record<string, unknown> | undefined;
    };

    expect(latestQueryState()).toMatchObject({
      sortBy: "latestUpdatedAt",
      sortDir: "desc",
    });

    fireEvent.click(screen.getByRole("button", { name: /Candidate/i }));

    await waitFor(() => {
      expect(latestQueryState()).toMatchObject({
        page: 1,
        sortBy: "candidateTitle",
        sortDir: "asc",
      });
    });
  });

  it("handles loading and error states correctly", () => {
    // ローディング状態
    vi.mocked(useQuery).mockReturnValueOnce({
      data: null,
      isLoading: true,
      isError: false,
    } as any);

    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <CandidatesPage />
      </QueryClientProvider>,
    );
    expect(screen.getByText("Loading candidates...")).toBeInTheDocument();

    // エラー状態
    vi.mocked(useQuery).mockReturnValueOnce({
      data: null,
      isLoading: false,
      isError: true,
    } as any);

    rerender(
      <QueryClientProvider client={queryClient}>
        <CandidatesPage />
      </QueryClientProvider>,
    );
    expect(screen.getByText("Failed to load candidates.")).toBeInTheDocument();

    // 空状態
    vi.mocked(useQuery).mockReturnValueOnce({
      data: { items: [], totalPages: 0 },
      isLoading: false,
      isError: false,
    } as any);

    rerender(
      <QueryClientProvider client={queryClient}>
        <CandidatesPage />
      </QueryClientProvider>,
    );
    expect(screen.getByText("No candidates found.")).toBeInTheDocument();
  });

  it("opens candidate details in a drawer from a table row", () => {
    render(
      <QueryClientProvider client={queryClient}>
        <CandidatesPage />
      </QueryClientProvider>,
    );

    expect(screen.queryByLabelText("Candidate details")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Rejected Candidate"));

    expect(screen.getByLabelText("Candidate details")).toBeInTheDocument();
    expect(screen.getByText("Original Candidate")).toBeInTheDocument();
    expect(screen.getByText("Covered Candidate")).toBeInTheDocument();
    expect(screen.queryByText("Final Knowledge")).not.toBeInTheDocument();
    expect(screen.getByText(/targetStateId: state-789/)).toBeInTheDocument();
    expect(screen.getByText(/references: 0/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByLabelText("Candidate details")).not.toBeInTheDocument();
  });

  it("handles page transitions (pagination) and refresh clicks correctly", () => {
    render(
      <QueryClientProvider client={queryClient}>
        <CandidatesPage />
      </QueryClientProvider>,
    );

    // ページ遷移ボタンの取得 (Chevron Left & Right のボタン)
    const buttons = screen.getAllByRole("button");
    const prevButton = buttons.find((btn) => btn.querySelector("svg.lucide-chevron-left"));
    const nextButton = buttons.find((btn) => btn.querySelector("svg.lucide-chevron-right"));

    if (nextButton) {
      fireEvent.click(nextButton);
    }
    if (prevButton) {
      fireEvent.click(prevButton);
    }

    // Refresh ボタンのクリック
    const refreshButton = screen.getByText("Refresh");
    fireEvent.click(refreshButton);
    expect(mockRefetch).toHaveBeenCalled();
  });

  it("passes work queue view changes to the candidates query", async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <CandidatesPage />
      </QueryClientProvider>,
    );

    const rejectedViewButton = screen.getAllByRole("button", { name: /Rejected/ })[0];
    expect(rejectedViewButton).toBeDefined();
    fireEvent.click(rejectedViewButton as HTMLElement);

    await waitFor(() => {
      const latestCall = vi.mocked(useQuery).mock.calls.at(-1)?.[0] as
        | { queryKey?: unknown[] }
        | undefined;
      const latestQueryState = latestCall?.queryKey?.[1] as Record<string, unknown> | undefined;
      expect(latestQueryState).toMatchObject({
        outcome: "rejected",
      });
    });
  });
});
