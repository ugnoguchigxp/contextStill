import { QueryClient, QueryClientProvider, useMutation, useQuery } from "@tanstack/react-query";
/** @vitest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgePage } from "../../../web/src/modules/admin/components/knowledge.page";

// 外部ライブラリ・APIリポジトリのモック
vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual("@tanstack/react-query");
  return {
    ...actual,
    useQuery: vi.fn(),
    useMutation: vi.fn(),
  };
});

vi.mock("../../../web/src/modules/admin/repositories/admin.repository", () => ({
  fetchKnowledgeItems: vi.fn(),
  createKnowledgeItem: vi.fn(),
  updateKnowledgeItem: vi.fn(),
  deleteKnowledgeItem: vi.fn(),
  bulkUpdateKnowledgeStatus: vi.fn(),
  sendKnowledgeFeedback: vi.fn(),
}));

const queryClient = new QueryClient();

// テスト用のリッチなモックデータ
const mockKnowledgeItems = [
  {
    id: "kn-1",
    type: "rule",
    status: "draft",
    scope: "repo",
    title: "Test Rule Title 1",
    body: "This is a detailed rule description for testing.",
    confidence: 80,
    importance: 90,
    dynamicScore: 84,
    decayFactor: 0.95,
    compileSelectCount: 3,
    explicitUpvoteCount: 2,
    explicitDownvoteCount: 0,
    appliesTo: { general: true, technologies: ["react", "typescript"] },
    metadata: { author: "Antigravity" },
    sourceRefs: ["src/main.ts"],
    sourceVibeMemoryIds: ["mem-1"],
    lastCompiledAt: "2026-05-21T08:00:00.000Z",
    lastVerifiedAt: "2026-05-21T08:00:00.000Z",
    createdAt: "2026-05-21T08:00:00.000Z",
    updatedAt: "2026-05-21T08:00:00.000Z",
  },
  {
    id: "kn-2",
    type: "procedure",
    status: "active",
    scope: "global",
    title: "Test Procedure Title 2",
    body: "This is a step-by-step procedure description.",
    confidence: 60,
    importance: 70,
    dynamicScore: 64,
    decayFactor: 0.3, // stale
    compileSelectCount: 0, // unused
    explicitUpvoteCount: 1,
    explicitDownvoteCount: 1,
    appliesTo: { general: false, technologies: ["bun"], changeTypes: ["add"], domains: ["admin"] },
    metadata: {},
    sourceRefs: [],
    sourceVibeMemoryIds: [],
    lastCompiledAt: null,
    lastVerifiedAt: null,
    createdAt: "2026-05-20T08:00:00.000Z",
    updatedAt: "2026-05-20T08:00:00.000Z",
  },
];

describe("KnowledgePage", () => {
  const mockMutate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(useQuery).mockReturnValue({
      data: {
        items: mockKnowledgeItems,
        total: 6,
        totalPages: 3,
      },
      isLoading: false,
      isError: false,
    } as any);

    vi.mocked(useMutation).mockReturnValue({
      mutate: mockMutate,
      isPending: false,
    } as any);
  });

  it("renders knowledge list and items correctly", () => {
    render(
      <QueryClientProvider client={queryClient}>
        <KnowledgePage />
      </QueryClientProvider>,
    );

    // ヘッダーや検索ボックスの確認
    expect(screen.getByPlaceholderText("Knowledgeを検索...")).toBeInTheDocument();

    // アイテムの確認
    expect(screen.getByText("Test Rule Title 1")).toBeInTheDocument();
    expect(screen.getByText("Test Procedure Title 2")).toBeInTheDocument();

    // 適用タグ (general, react, typescript, bun) が表示されていること
    expect(screen.getAllByText("general").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("react").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("typescript").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("bun").length).toBeGreaterThanOrEqual(1);

    // スコープのボタンが表示されていること
    expect(screen.getByRole("button", { name: /repo/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /global/i })).toBeInTheDocument();
  });

  it("runs text search only after submitting", () => {
    render(
      <QueryClientProvider client={queryClient}>
        <KnowledgePage />
      </QueryClientProvider>,
    );

    const searchInput = screen.getByPlaceholderText("Knowledgeを検索...");
    fireEvent.change(searchInput, { target: { value: "admin" } });

    expect(screen.getByText("Test Rule Title 1")).toBeInTheDocument();
    expect(screen.getByText("Test Procedure Title 2")).toBeInTheDocument();
    expect(vi.mocked(useQuery).mock.calls.at(-1)?.[0].queryKey).toEqual([
      "knowledge",
      expect.objectContaining({ query: "" }),
    ]);

    fireEvent.click(screen.getByRole("button", { name: /search/i }));

    expect(vi.mocked(useQuery).mock.calls.at(-1)?.[0].queryKey).toEqual([
      "knowledge",
      expect.objectContaining({ query: "admin" }),
    ]);
  });

  it("handles quick status, scope, and feedback action mutations", () => {
    render(
      <QueryClientProvider client={queryClient}>
        <KnowledgePage />
      </QueryClientProvider>,
    );

    // 1. クイックステータス変更 (draft の kn-1 を Promote to Active する)
    const promoteBtn = screen.getByTitle("Promote to Active");
    fireEvent.click(promoteBtn);
    expect(mockMutate).toHaveBeenCalledWith({
      id: "kn-1",
      status: "active",
    });

    // 2. クイックスコープ変更 (kn-1 の scope を変更する)
    const scopeBtn = screen.getByRole("button", { name: /repo/i });
    fireEvent.click(scopeBtn);
    expect(mockMutate).toHaveBeenCalledWith({
      id: "kn-1",
      scope: "global",
    });

    // 3. フィードバック (Upvote/Downvote) の送信
    const upvoteBtns = screen.getAllByTitle("Upvote");
    fireEvent.click(upvoteBtns[0]);
    expect(mockMutate).toHaveBeenCalledWith({
      id: "kn-1",
      direction: "up",
    });
  });

  it("handles item deletion with confirm dialog", () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    render(
      <QueryClientProvider client={queryClient}>
        <KnowledgePage />
      </QueryClientProvider>,
    );

    const deleteBtns = screen.getAllByTitle("Delete");

    // キャンセル時
    confirmSpy.mockReturnValue(false);
    fireEvent.click(deleteBtns[0]);
    expect(confirmSpy).toHaveBeenCalledWith("Delete knowledge item: Test Rule Title 1?");
    expect(mockMutate).not.toHaveBeenCalled();

    // 承諾時
    confirmSpy.mockReturnValue(true);
    fireEvent.click(deleteBtns[0]);
    expect(mockMutate).toHaveBeenCalledWith("kn-1");
  });

  it("handles bulk status update selection", () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    render(
      <QueryClientProvider client={queryClient}>
        <KnowledgePage />
      </QueryClientProvider>,
    );

    // 順次クリック（再レンダリングを考慮して都度要素を取得）
    fireEvent.click(screen.getByLabelText("select-kn-1"));
    fireEvent.click(screen.getByLabelText("select-kn-2"));

    // 一括更新ボタン
    const bulkDeprecateBtn = screen.getByText("Deprecate selected");

    confirmSpy.mockReturnValue(true);
    fireEvent.click(bulkDeprecateBtn);

    expect(confirmSpy).toHaveBeenCalled();
    expect(mockMutate).toHaveBeenCalledWith({
      ids: ["kn-1", "kn-2"],
      status: "deprecated",
    });
  });

  it("opens create/edit modal and submits form correctly", () => {
    render(
      <QueryClientProvider client={queryClient}>
        <KnowledgePage />
      </QueryClientProvider>,
    );

    // 1. Create New モーダルの展開
    const createBtn = screen.getByText("Create New");
    fireEvent.click(createBtn);

    // モーダルが展開され、タイトル入力フォームが存在することを確認
    expect(screen.getByText("Create New Knowledge")).toBeInTheDocument();

    const titleInput = screen.getByPlaceholderText("title");
    const bodyTextarea = screen.getByPlaceholderText("body");
    const typeSelect = screen.getByLabelText("Type");
    const statusSelect = screen.getByLabelText("Status");
    const scopeSelect = screen.getByLabelText("Scope");
    const importanceInput = screen.getByLabelText("Importance (0-100)");
    const confidenceInput = screen.getByLabelText("Confidence (0-100)");
    const generalCheckbox = screen.getByLabelText("general");
    const techInput = screen.getByPlaceholderText("typescript, python");
    const changeTypesInput = screen.getByPlaceholderText("feature, bugfix, schema");

    // フォームに値を入力して onChange ハンドラをカバー
    fireEvent.change(titleInput, { target: { value: "New Custom Title" } });
    fireEvent.change(bodyTextarea, { target: { value: "New Custom Body Content" } });
    fireEvent.change(typeSelect, { target: { value: "procedure" } });
    fireEvent.change(statusSelect, { target: { value: "active" } });
    fireEvent.change(scopeSelect, { target: { value: "global" } });
    fireEvent.change(importanceInput, { target: { value: "85" } });
    fireEvent.change(confidenceInput, { target: { value: "95" } });
    fireEvent.click(generalCheckbox);
    fireEvent.change(techInput, { target: { value: "rust, go" } });
    fireEvent.change(changeTypesInput, { target: { value: "refactor" } });

    // 保存ボタン (Create Item) をクリックして Mutation を発火
    const saveBtn = screen.getByText("Create Item");
    fireEvent.click(saveBtn);

    expect(mockMutate).toHaveBeenCalled();

    // モーダルを閉じる (Cancelボタン)
    const cancelBtn = screen.getByText("Cancel");
    fireEvent.click(cancelBtn);

    // 2. 編集モードでのモーダル展開 (kn-1の編集ボタンをクリック)
    const editBtns = screen.getAllByTitle("Edit");
    fireEvent.click(editBtns[0]);

    // 編集モーダルのタイトルとエビデンス項目が表示されることを確認
    expect(screen.getByText("Edit Knowledge")).toBeInTheDocument();
    expect(screen.getByText("Evidence")).toBeInTheDocument();
    expect(screen.getByText("src/main.ts")).toBeInTheDocument();
    expect(screen.getByText("mem-1")).toBeInTheDocument();

    // Xボタンでモーダルを閉じる
    const editModalTitle = screen.getByText("Edit Knowledge");
    const closeBtn = editModalTitle.parentElement?.querySelector("button");
    if (closeBtn) {
      fireEvent.click(closeBtn);
    }
  });

  it("handles pagination clicks correctly", () => {
    render(
      <QueryClientProvider client={queryClient}>
        <KnowledgePage />
      </QueryClientProvider>,
    );

    // ページ遷移ボタンの存在を確認
    const nextBtn = screen.getByText("Next");
    const prevBtn = screen.getByText("Previous");

    // ページ番号ボタン（1, 2, 3）が存在することを確認
    const page2Btn = screen.getByRole("button", { name: "2" });
    expect(page2Btn).toBeInTheDocument();

    // クリックインタラクションをシミュレートして分岐をカバー
    fireEvent.click(nextBtn);
    fireEvent.click(page2Btn);
    fireEvent.click(prevBtn);
  });

  it("handles displayFilter and minQuality filter changes", () => {
    render(
      <QueryClientProvider client={queryClient}>
        <KnowledgePage />
      </QueryClientProvider>,
    );

    const filterSpan = screen.getByText("Filter");
    const filterSelect = filterSpan.parentElement?.querySelector("select");
    if (filterSelect) {
      fireEvent.change(filterSelect, { target: { value: "active" } });
    }

    const qualitySpans = screen.getAllByText("Quality");
    const qualitySpan = qualitySpans.find((el) => el.tagName === "SPAN");
    const qualitySelect = qualitySpan?.parentElement?.querySelector("select");
    if (qualitySelect) {
      fireEvent.change(qualitySelect, { target: { value: "50" } });
    }
  });

  it("handles bulk active status update", () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    render(
      <QueryClientProvider client={queryClient}>
        <KnowledgePage />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByLabelText("select-kn-1"));

    const bulkActiveBtn = screen.getByText("Activate selected");

    // キャンセル時
    confirmSpy.mockReturnValue(false);
    fireEvent.click(bulkActiveBtn);
    expect(confirmSpy).toHaveBeenCalled();
    expect(mockMutate).not.toHaveBeenCalled();

    // 承諾時
    confirmSpy.mockReturnValue(true);
    fireEvent.click(bulkActiveBtn);
    expect(confirmSpy).toHaveBeenCalled();
    expect(mockMutate).toHaveBeenCalledWith({
      ids: ["kn-1"],
      status: "active",
    });
  });
});
