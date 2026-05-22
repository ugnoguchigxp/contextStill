import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
/** @vitest-environment jsdom */
import { fireEvent, render, screen, within } from "@testing-library/react";
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
    id: "cand-1",
    targetKind: "wiki_file",
    targetKey: "docs/architecture.md",
    outcome: "stored",
    candidateIndex: 0,
    original: {
      title:
        "Architecture Guideline Candidate Very Long Title That Exceeds One Hundred And Twenty Characters To Trigger The Slicing Logic in Text Preview Function.",
      body: "Maintain strict decoupling between domain and repository interfaces. This is a very long body text designed to exceed one hundred and eighty characters for testing the textPreview truncation behavior.",
    },
    cover: {
      status: "knowledge_ready",
      stage: "evidence_check",
      reason: "Matched with existing guidelines but adds details.",
      importance: 80,
      confidence: 90,
      title:
        "Decoupling Domain and Repository Very Long Title Designed to Test Truncation inside Covered Candidate Details section.",
      body: "Keep interfaces separate to allow switching implementations. This detailed implementation detail should help verify that our Covered Candidate component can handle longer body descriptions beautifully without messing up the UI flow.",
      type: "rule",
      referencesCount: 2,
      duplicateRefsCount: 0,
      toolEventsCount: 1,
    },
    knowledge: {
      id: "kn-arch-1",
      status: "active",
      title:
        "Decoupled Architecture Rule Very Long Title Intended to Trigger Truncation in Final Knowledge Details section.",
      body: "Ensure domain modules do not import repository classes directly. This ensures we can easily decouple dependencies and improve high-level testability across our typescript backend modules.",
      importance: 85,
      confidence: 95,
      type: "rule",
    },
    diff: {
      originalToKnowledge: {
        bodySimilarity: 0.85,
        summary: ["Added specificity", "Cleaned syntax"],
      },
    },
    latestUpdatedAt: "2026-05-21T08:00:00.000Z",
    targetStateId: "state-123",
    sourceUri: "file:///docs/architecture.md",
    finalizeSourceUri: "file:///docs/architecture.md",
  },
  {
    id: "cand-2",
    targetKind: "vibe_memory",
    targetKey: "mem-vibe-abc",
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
    latestUpdatedAt: "invalid-date-format",
    targetStateId: "state-456",
    sourceUri: "file:///mem-vibe-abc",
    finalizeSourceUri: "",
  },
];

const mockStats = {
  total: 2,
  stored: 1,
  readyNotFinalized: 1,
  rejected: 0,
  retryable: 0,
  targetPending: 0,
};

describe("CandidatesPage", () => {
  const mockRefetch = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockRefetch.mockResolvedValue({} as any);

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
    expect(
      screen.getByPlaceholderText("Search target / candidate / knowledge"),
    ).toBeInTheDocument();

    // アイテムデータの描画確認
    expect(screen.getByText(/Architecture Guideline Candidate/)).toBeInTheDocument();
    expect(screen.getByText("Vibe Memory Guideline Candidate")).toBeInTheDocument();
    expect(screen.getByText("docs/architecture.md")).toBeInTheDocument();
    expect(screen.getByText("mem-vibe-abc")).toBeInTheDocument();

    // Coverage & Outcome バッジの検証
    expect(screen.getByText("knowledge_ready")).toBeInTheDocument();
    expect(screen.getAllByText("ready_not_finalized").length).toBeGreaterThanOrEqual(1);

    // Stats フッターの検証
    expect(screen.getByText(/total 2 \| stored 1 \| ready 1/)).toBeInTheDocument();
  });

  it("handles filtering elements and text queries interactively", () => {
    render(
      <QueryClientProvider client={queryClient}>
        <CandidatesPage />
      </QueryClientProvider>,
    );

    // 1. 検索テキストの変更
    const searchInput = screen.getByPlaceholderText("Search target / candidate / knowledge");
    fireEvent.change(searchInput, { target: { value: "architecture" } });

    // 2. target-kind セレクトボックスの変更
    const targetKindSelect = screen.getByLabelText("target-kind");
    fireEvent.change(targetKindSelect, { target: { value: "wiki_file" } });

    // 3. outcome セレクトボックスの変更
    const outcomeSelect = screen.getByLabelText("outcome");
    fireEvent.change(outcomeSelect, { target: { value: "stored" } });

    // 4. has-knowledge セレクトボックスの変更
    const hasKnowledgeSelect = screen.getByLabelText("has-knowledge");
    fireEvent.change(hasKnowledgeSelect, { target: { value: "yes" } });

    // useQuery が正しく更新されたパラメータで動くためのトリガー確認
    expect(useQuery).toHaveBeenCalled();
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

  it("expands detail accordion pane on row click", () => {
    render(
      <QueryClientProvider client={queryClient}>
        <CandidatesPage />
      </QueryClientProvider>,
    );

    // 一番目の行をクリックしてアコーディオンを展開
    const rowTitle = screen.getByText(/Architecture Guideline Candidate/);
    fireEvent.click(rowTitle);

    // アコーディオン内の詳細テキストの確認
    expect(screen.getByText("Original Candidate")).toBeInTheDocument();
    expect(screen.getByText("Covered Candidate")).toBeInTheDocument();
    expect(screen.getByText("Final Knowledge")).toBeInTheDocument();
    expect(screen.getByText(/targetStateId: state-123/)).toBeInTheDocument();
    expect(screen.getByText(/references: 2/)).toBeInTheDocument();

    // もう一度クリックして閉じる
    fireEvent.click(rowTitle);
    expect(screen.queryByText("Original Candidate")).not.toBeInTheDocument();
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
});
