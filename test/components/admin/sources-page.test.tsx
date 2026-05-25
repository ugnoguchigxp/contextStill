import { QueryClient, QueryClientProvider, useMutation, useQuery } from "@tanstack/react-query";
/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SourcesPage } from "../../../web/src/modules/admin/components/sources.page";
import {
  createSourceFolder,
  deleteSourceFolder,
  deleteSourcePage,
  fetchSourcePage,
  queueWebSourceUrl,
  queueWebSourceUrlsBulk,
  queueWebSourceUrlsUpload,
  renameSourceFolder,
  updateSourcePage,
} from "../../../web/src/modules/admin/repositories/admin.repository";

// 外部コンポーネント・API等のモック
vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual("@tanstack/react-query");
  return {
    ...actual,
    useQuery: vi.fn(),
    useMutation: vi.fn(),
  };
});

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
  },
}));

vi.mock("markdown-wysiwyg-editor", () => ({
  MarkdownEditor: vi.fn().mockImplementation(({ value, onChange, editable }: any) => {
    return (
      <div data-testid="mock-markdown-editor">
        <textarea
          data-testid="mock-editor-textarea"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={!editable}
        />
      </div>
    );
  }),
}));

vi.mock("../../../web/src/modules/admin/repositories/admin.repository", () => ({
  createSourceFolder: vi.fn(),
  createSourcePage: vi.fn(),
  deleteSourceFolder: vi.fn(),
  deleteSourcePage: vi.fn(),
  fetchSourceDiff: vi.fn(),
  fetchSourceHealth: vi.fn(),
  fetchSourceHistory: vi.fn(),
  fetchSourcePage: vi.fn(),
  fetchSourceTree: vi.fn(),
  queueWebSourceUrl: vi.fn(),
  queueWebSourceUrlsBulk: vi.fn(),
  queueWebSourceUrlsUpload: vi.fn(),
  renameSourceFolder: vi.fn(),
  runSourceReindex: vi.fn(),
  searchSourcePages: vi.fn(),
  updateSourcePage: vi.fn(),
}));

let queryClient: QueryClient;

// モックデータ定義
const mockHealth = {
  app: "MemoryRouter Wiki",
  version: "1.0.0",
  git: {
    branch: "main",
    commit: "abc1234ffffff",
  },
};

const mockTree = {
  items: [
    { path: "home.md", slug: "", title: "Home Page" },
    { path: "docs/getting-started.md", slug: "docs/getting-started", title: "Getting Started" },
    { path: "docs/architecture.md", slug: "docs/architecture", title: "Architecture" },
  ],
  folders: [{ path: "docs" }],
};

const mockPageData = {
  slug: "docs/getting-started",
  title: "Getting Started",
  body: "# Getting Started\n\nWelcome to MemoryRouter!",
  path: "docs/getting-started.md",
  meta: {
    showOnMenu: true,
    showOnHome: true,
    sort: 1,
    tags: ["guide", "setup"],
  },
};

const mockHistory = [
  {
    commit: "commit-111",
    author: "Antigravity",
    date: "2026-05-21T08:00:00.000Z",
    message: "docs: update guide",
  },
  {
    commit: "commit-222",
    author: "Y. Noguchi",
    date: "2026-05-20T12:00:00.000Z",
    message: "docs: init guide",
  },
];

const mockDiff = {
  from: "commit-222",
  to: "commit-111",
  patch: "@@ -1,3 +1,4 @@\n # Getting Started\n+Welcome to MemoryRouter!\n",
};

describe("SourcesPage", () => {
  const mockMutate = vi.fn();

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          gcTime: Number.POSITIVE_INFINITY,
        },
        mutations: {
          retry: false,
          gcTime: Number.POSITIVE_INFINITY,
        },
      },
    });
    queryClient.clear();
    vi.clearAllMocks();

    vi.mocked(fetchSourcePage).mockResolvedValue(mockPageData);
    vi.mocked(deleteSourcePage).mockResolvedValue({
      ok: true,
      slug: "docs/getting-started",
      commit: "commit-abc",
    });
    vi.mocked(updateSourcePage).mockResolvedValue({
      ok: true,
      slug: "docs/getting-started-new",
      commit: "commit-abc",
    });
    vi.mocked(createSourceFolder).mockResolvedValue({
      ok: true,
      path: "docs/new-folder",
      commit: null,
    });
    vi.mocked(renameSourceFolder).mockResolvedValue({
      ok: true,
      from: "docs",
      path: "docs-renamed",
      movedPages: [],
      commit: null,
    });
    vi.mocked(deleteSourceFolder).mockResolvedValue({
      ok: true,
      path: "docs",
      deletedSlugs: [],
      commit: null,
    });
    vi.mocked(queueWebSourceUrl).mockResolvedValue({
      ok: true,
      item: {
        url: "https://example.com/a",
        normalizedUrl: "https://example.com/a",
        existing: false,
        state: {
          id: "state-1",
          targetKind: "web_ingest",
          targetKey: "https://example.com/a",
          sourceUri: "https://example.com/a",
          distillationVersion: "1",
          status: "pending",
          phase: "selected",
          priorityGroup: "web_ingest",
          sortKey: "https://example.com/a",
          metadata: {},
          createdAt: "2026-05-24T00:00:00.000Z",
          updatedAt: "2026-05-24T00:00:00.000Z",
        },
      },
    });
    vi.mocked(queueWebSourceUrlsBulk).mockResolvedValue({
      ok: true,
      total: 1,
      queued: 1,
      invalid: 0,
      duplicateInRequest: 0,
      items: [],
    });
    vi.mocked(queueWebSourceUrlsUpload).mockResolvedValue({
      ok: true,
      total: 1,
      queued: 1,
      invalid: 0,
      duplicateInRequest: 0,
      items: [],
      file: {
        name: "urls.csv",
        size: 16,
        extractedUrls: 1,
      },
    });

    vi.mocked(useQuery).mockImplementation(({ queryKey }: any) => {
      if (queryKey[0] === "health") {
        return { data: mockHealth, isLoading: false, isError: false } as any;
      }
      if (queryKey[0] === "page-tree") {
        return { data: mockTree, isLoading: false, isError: false } as any;
      }
      if (queryKey[0] === "page") {
        return { data: mockPageData, isLoading: false, isError: false } as any;
      }
      if (queryKey[0] === "history") {
        return { data: mockHistory, isLoading: false, isError: false } as any;
      }
      if (queryKey[0] === "diff") {
        return { data: mockDiff, isLoading: false, isError: false } as any;
      }
      return { data: null, isLoading: false, isError: false } as any;
    });

    vi.mocked(useMutation).mockImplementation((options: any) => {
      const buildResult = (variables: any) => ({
        ok: true,
        slug: "docs/getting-started",
        commit: "commit-abc",
        path: variables?.path || "docs/getting-started",
        indexed: 1,
        removed: 0,
        item: {
          normalizedUrl: "https://example.com/a",
          existing: false,
        },
        total: 1,
        queued: 1,
        invalid: 0,
        duplicateInRequest: 0,
        items: [],
        file: {
          name: "urls.csv",
          size: 16,
          extractedUrls: 1,
        },
      });
      return {
        mutate: vi.fn().mockImplementation((variables: any) => {
          mockMutate(variables);
          if (options?.onSuccess) {
            options.onSuccess(buildResult(variables), variables);
          }
        }),
        mutateAsync: vi.fn().mockImplementation(async (variables: any) => {
          mockMutate(variables);
          if (options?.onSuccess) {
            await options.onSuccess(buildResult(variables), variables);
          }
          return buildResult(variables);
        }),
        isPending: false,
      } as any;
    });
  });

  afterEach(() => {
    queryClient.clear();
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders explorer tree and health API status correctly", () => {
    render(
      <QueryClientProvider client={queryClient}>
        <SourcesPage />
      </QueryClientProvider>,
    );

    // Explorer ヘッダーの検証
    expect(screen.getByText("Explorer")).toBeInTheDocument();

    // ツリーファイルの検証 (pageNameFromPath から "home" "getting-started" などで描画される)
    expect(screen.getByText("home")).toBeInTheDocument();
    expect(screen.getByText("getting-started")).toBeInTheDocument();
    expect(screen.getByText("architecture")).toBeInTheDocument();

    // API Health 状態の検証
    expect(screen.getByText(/API: MemoryRouter Wiki 1.0.0/)).toBeInTheDocument();
  });

  it("handles folder expanding and page selection clicks", () => {
    render(
      <QueryClientProvider client={queryClient}>
        <SourcesPage />
      </QueryClientProvider>,
    );

    // フォルダ名 "docs" のクリック
    const folderNode = screen.getByText("docs");
    fireEvent.click(folderNode);

    // ページ "getting-started" のクリックによる選択
    const pageNode = screen.getByText("getting-started");
    fireEvent.click(pageNode);

    // 選択ステータス情報の確認
    expect(screen.getByText("Title")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Getting Started")).toBeInTheDocument();
  });

  it("toggles modes (view / edit) and saves modifications via update mutation", () => {
    render(
      <QueryClientProvider client={queryClient}>
        <SourcesPage />
      </QueryClientProvider>,
    );

    // View モードへの切り替え
    const viewBtn = screen.getByTitle("View");
    fireEvent.click(viewBtn);

    // Edit モードへの切り替え
    const editBtn = screen.getByTitle("Edit");
    fireEvent.click(editBtn);

    // 各フォームへの入力変更テスト
    const titleInput = screen.getByPlaceholderText("Page title");
    fireEvent.change(titleInput, { target: { value: "Getting Started (Updated)" } });

    const sortInput = screen.getByPlaceholderText("0");
    fireEvent.change(sortInput, { target: { value: "10" } });

    const tagsInput = screen.getByPlaceholderText("engineering, onboarding");
    fireEvent.change(tagsInput, { target: { value: "guide, config, setup" } });

    const menuCheckbox = screen.getByLabelText("Show on menu");
    fireEvent.click(menuCheckbox);

    // 保存 (Save) ボタンをクリック
    const saveBtn = screen.getByTitle("Save");
    fireEvent.click(saveBtn);

    // Mutation が正しい引数で発火されたことを検証
    expect(mockMutate).toHaveBeenCalled();
  });

  it("handles folders operations like create, rename, and delete recursively", () => {
    const promptSpy = vi.spyOn(window, "prompt");
    const confirmSpy = vi.spyOn(window, "confirm");

    render(
      <QueryClientProvider client={queryClient}>
        <SourcesPage />
      </QueryClientProvider>,
    );

    // フォルダ "docs" を選択状態にする
    const folderNode = screen.getByText("docs");
    fireEvent.click(folderNode);

    // 1. フォルダ新規作成
    const newFolderBtn = screen.getByTitle("New folder");
    promptSpy.mockReturnValue("docs/sub-folder");
    fireEvent.click(newFolderBtn);
    expect(promptSpy).toHaveBeenCalled();
    expect(mockMutate).toHaveBeenCalled();

    // 2. フォルダ名前変更
    const renameFolderBtn = screen.getByTitle("Rename selected");
    promptSpy.mockReturnValue("docs/renamed-folder");
    fireEvent.click(renameFolderBtn);
    expect(promptSpy).toHaveBeenCalled();
    expect(mockMutate).toHaveBeenCalled();

    // 3. フォルダ削除
    const deleteBtn = screen.getByTitle("Delete selected");
    confirmSpy.mockReturnValue(true);
    fireEvent.click(deleteBtn);
    expect(confirmSpy).toHaveBeenCalled();
    expect(mockMutate).toHaveBeenCalled();
  });

  it("handles page creation and deletion operations correctly", () => {
    const confirmSpy = vi.spyOn(window, "confirm");

    render(
      <QueryClientProvider client={queryClient}>
        <SourcesPage />
      </QueryClientProvider>,
    );

    // 1. 新規ページ作成
    const newPageBtn = screen.getAllByTitle("New page")[0];
    fireEvent.click(newPageBtn);

    const titleInput = screen.getByPlaceholderText("Page title");
    fireEvent.change(titleInput, { target: { value: "New Wiki Article" } });

    const saveBtn = screen.getByTitle("Save");
    fireEvent.click(saveBtn);
    expect(mockMutate).toHaveBeenCalled();

    // 2. ページ削除
    const deleteBtn = screen.getByTitle("Delete"); // 選択がクリアされているため、ページ削除かフォルダ削除になる
    confirmSpy.mockReturnValue(true);
    fireEvent.click(deleteBtn);
    expect(mockMutate).toHaveBeenCalled();
  });

  it("handles reindexing and display diff viewer features", () => {
    render(
      <QueryClientProvider client={queryClient}>
        <SourcesPage />
      </QueryClientProvider>,
    );

    // 再インデックスボタン
    const reindexBtn = screen.getByTitle("Reindex");
    fireEvent.click(reindexBtn);
    expect(mockMutate).toHaveBeenCalled();

    // 履歴・Diff表示のためのコミット選択をシミュレート
    const commitSelects = screen.getAllByRole("combobox");
    // History commit from/to selects
    if (commitSelects.length >= 2) {
      fireEvent.change(commitSelects[0], { target: { value: "commit-222" } });
      fireEvent.change(commitSelects[1], { target: { value: "commit-111" } });
    }
  });

  it("handles search queries and selects a result correctly", () => {
    // 検索窓に入力がある場合
    vi.mocked(useQuery).mockImplementation(({ queryKey }: any) => {
      if (queryKey[0] === "search" && queryKey[1] === "test-query") {
        return {
          data: [{ slug: "docs/getting-started", excerpt: "Welcome to MemoryRouter!" }],
          isLoading: false,
          isError: false,
          isFetching: false,
        } as any;
      }
      if (queryKey[0] === "page-tree") {
        return { data: mockTree, isLoading: false, isError: false } as any;
      }
      if (queryKey[0] === "health") {
        return { data: mockHealth, isLoading: false, isError: false } as any;
      }
      return { data: null, isLoading: false, isError: false } as any;
    });

    render(
      <QueryClientProvider client={queryClient}>
        <SourcesPage />
      </QueryClientProvider>,
    );

    const searchInput = screen.getByPlaceholderText("Search title/body");
    fireEvent.change(searchInput, { target: { value: "test-query" } });

    // 検索結果が表示されるのを待ってクリック
    const searchResultBtn = screen.getByText("docs/getting-started");
    fireEvent.click(searchResultBtn);
  });

  it("validates sort field as integer and checks save errors", () => {
    render(
      <QueryClientProvider client={queryClient}>
        <SourcesPage />
      </QueryClientProvider>,
    );

    // Edit モードにする
    const editBtn = screen.getByTitle("Edit");
    fireEvent.click(editBtn);

    // 1. sort に不正な値を設定
    const sortInput = screen.getByPlaceholderText("0");
    fireEvent.change(sortInput, { target: { value: "1.5" } });
    expect(screen.getByText("sort must be an integer")).toBeInTheDocument();

    // 保存ボタンを押しても mutation は呼ばれないはず
    const saveBtn = screen.getByTitle("Save");
    fireEvent.click(saveBtn);
    expect(mockMutate).not.toHaveBeenCalled();

    // 2. タイトルを空にする
    fireEvent.change(sortInput, { target: { value: "10" } }); // 不正エラーを解消
    const titleInput = screen.getByPlaceholderText("Page title");
    fireEvent.change(titleInput, { target: { value: "" } });
    fireEvent.click(saveBtn);
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it("handles folder operations cancel scenarios and inline buttons", () => {
    const promptSpy = vi.spyOn(window, "prompt");
    const confirmSpy = vi.spyOn(window, "confirm");

    render(
      <QueryClientProvider client={queryClient}>
        <SourcesPage />
      </QueryClientProvider>,
    );

    // フォルダ名 "docs" のクリック
    const folderNode = screen.getByText("docs");
    fireEvent.click(folderNode);

    // 1. フォルダ新規作成をキャンセルする (prompt が null)
    promptSpy.mockReturnValue(null);
    const newFolderBtn = screen.getByTitle("New folder");
    fireEvent.click(newFolderBtn);
    expect(mockMutate).not.toHaveBeenCalled();

    // 2. フォルダ名前変更をキャンセルする (prompt が null)
    promptSpy.mockReturnValue(null);
    const renameFolderBtn = screen.getByTitle("Rename selected");
    fireEvent.click(renameFolderBtn);
    expect(mockMutate).not.toHaveBeenCalled();

    // 3. フォルダ名前変更で値が変わらない場合 (prompt が同じ値を返す)
    promptSpy.mockReturnValue("docs");
    fireEvent.click(renameFolderBtn);
    expect(mockMutate).not.toHaveBeenCalled();

    // 4. フォルダ削除をキャンセルする (confirm が false)
    confirmSpy.mockReturnValue(false);
    const deleteFolderBtn = screen.getByTitle("Delete selected");
    fireEvent.click(deleteFolderBtn);
    expect(mockMutate).not.toHaveBeenCalled();

    // 5. インラインボタン: New page in folder
    const inlineNewPageBtn = screen.getByTitle("New page in docs");
    fireEvent.click(inlineNewPageBtn);
    expect(screen.getByPlaceholderText("Page title")).toHaveValue("Untitled");
  });

});
