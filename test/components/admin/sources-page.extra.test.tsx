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
          status: "pending",
          priority: 20,
          attemptCount: 0,
          sourceKind: "web_ingest",
          sourceKey: "https://example.com/a",
          sourceUri: "https://example.com/a",
          distillationVersion: "1",
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

  it("supports drag and drop events", () => {
    render(
      <QueryClientProvider client={queryClient}>
        <SourcesPage />
      </QueryClientProvider>,
    );

    // ドラッグ＆ドロップ用要素の取得
    const folderTreeItem = screen.getByText("docs").closest('[role="treeitem"]');
    const pageTreeItem = screen.getByText("getting-started").closest('[role="treeitem"]');

    if (!folderTreeItem || !pageTreeItem) {
      throw new Error("Tree items not found");
    }

    // dragstart シミュレート
    const dragStartEvent = {
      dataTransfer: {
        effectAllowed: "",
        setData: vi.fn(),
        getData: vi.fn().mockReturnValue(
          JSON.stringify({
            kind: "page",
            slug: "docs/getting-started",
            path: "docs/getting-started.md",
          }),
        ),
      },
    };
    fireEvent.dragStart(pageTreeItem, dragStartEvent);
    expect(dragStartEvent.dataTransfer.setData).toHaveBeenCalled();

    // dragover と drop シミュレート
    const dragOverEvent = {
      dataTransfer: { dropEffect: "" },
    };
    fireEvent.dragOver(folderTreeItem, dragOverEvent);

    const dropEvent = {
      dataTransfer: {
        getData: vi.fn().mockReturnValue(
          JSON.stringify({
            kind: "page",
            slug: "docs/getting-started",
            path: "docs/getting-started.md",
          }),
        ),
      },
    };
    fireEvent.drop(folderTreeItem, dropEvent);
  });

  it("covers additional edge cases to maximize coverage", async () => {
    const promptSpy = vi.spyOn(window, "prompt");
    const confirmSpy = vi.spyOn(window, "confirm");

    render(
      <QueryClientProvider client={queryClient}>
        <SourcesPage />
      </QueryClientProvider>,
    );

    // 1. 履歴コミットクリックによる diffTo 設定 (初期アクティブページ "" のロード完了を待つ)
    await screen.findByText("home");
    // まずページを選択して activeSlug を null 以外にする (これで historyQuery が enabled になる)
    const pageNode = screen.getByText("getting-started");
    fireEvent.click(pageNode);

    const commitBtn = await screen.findByText("commit-1");
    fireEvent.click(commitBtn);

    // 2. promptRenamePage でのキャンセル (Rename page home)
    const renamePageBtn = screen.getByTitle("Rename page home");
    promptSpy.mockReturnValue(null);
    fireEvent.click(renamePageBtn);
    expect(mockMutate).not.toHaveBeenCalled();

    // 3. promptRenamePage で同じ名前を指定する (元の "" に対し "index" または "" を指定)
    promptSpy.mockReturnValue("index");
    fireEvent.click(renamePageBtn);
    // マイクロタスクの完了を待っても呼ばれないことを確認
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mockMutate).not.toHaveBeenCalled();

    // 4. promptRenamePage で新しい名前を指定して Mutation を呼ぶ
    promptSpy.mockReturnValue("getting-started-new");
    fireEvent.click(renamePageBtn);
    await vi.waitFor(() => expect(mockMutate).toHaveBeenCalled());

    // 5. promptCreateFolder で空文字列を返す
    mockMutate.mockClear();
    promptSpy.mockReturnValue("/");
    const newFolderBtn = screen.getByTitle("New folder");
    fireEvent.click(newFolderBtn);
    expect(screen.getByText("folder path is required")).toBeInTheDocument();

    // 6. deletePageBySlug でキャンセル
    const deletePageBtn = screen.getByTitle("Delete page home");
    confirmSpy.mockReturnValue(false);
    fireEvent.click(deletePageBtn);
    expect(mockMutate).not.toHaveBeenCalled();

    // 7. deletePageBySlug で実行
    confirmSpy.mockReturnValue(true);
    fireEvent.click(deletePageBtn);
    await vi.waitFor(() => expect(mockMutate).toHaveBeenCalled());
  });

  it("covers error states for mutations", async () => {
    // 1. useMutation でエラーをシミュレートするモックへ一時的に変更
    vi.mocked(useMutation).mockImplementation((options: any) => {
      return {
        mutate: vi.fn().mockImplementation((variables: any) => {
          mockMutate(variables);
          if (options?.onError) {
            options.onError(new Error("Mocked Mutation Error"));
          }
        }),
        mutateAsync: vi.fn().mockImplementation(async (variables: any) => {
          mockMutate(variables);
          if (options?.onError) {
            options.onError(new Error("Mocked Mutation Error"));
          }
          return null;
        }),
        isPending: false,
      } as any;
    });

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("test-error-path");

    render(
      <QueryClientProvider client={queryClient}>
        <SourcesPage />
      </QueryClientProvider>,
    );

    // 各種 Mutation のエラーハンドリング (onError) を走らせる
    // A. フォルダ新規作成 (エラー)
    const newFolderBtn = screen.getByTitle("New folder");
    fireEvent.click(newFolderBtn);
    await vi.waitFor(() => expect(screen.getByText(/Folder create failed:/)).toBeInTheDocument());

    // B. フォルダ名前変更 (エラー)
    // フォルダ名 "docs" のクリック
    const folderNode = screen.getByText("docs");
    fireEvent.click(folderNode);
    const renameFolderBtn = screen.getByTitle("Rename selected");
    fireEvent.click(renameFolderBtn);
    await vi.waitFor(() => expect(screen.getByText(/Folder rename failed:/)).toBeInTheDocument());

    // C. フォルダ削除 (エラー)
    const deleteBtn = screen.getByTitle("Delete selected");
    fireEvent.click(deleteBtn);
    await vi.waitFor(() => expect(screen.getByText(/Folder delete failed:/)).toBeInTheDocument());

    // D. 再インデックス (エラー)
    const reindexBtn = screen.getByTitle("Reindex");
    fireEvent.click(reindexBtn);
    await vi.waitFor(() => expect(screen.getByText(/Reindex failed:/)).toBeInTheDocument());

    // E. ページ保存 (エラー)
    const editBtn = screen.getByTitle("Edit");
    fireEvent.click(editBtn);
    const saveBtn = screen.getByTitle("Save");
    fireEvent.click(saveBtn);
    await vi.waitFor(() => expect(screen.getByText(/Save failed:/)).toBeInTheDocument());

    // F. ページ削除 (エラー)
    const pageNodeForDelete = screen.getByText("getting-started");
    fireEvent.click(pageNodeForDelete);
    const deletePageBtn = screen.getByTitle("Delete");
    fireEvent.click(deletePageBtn);
    await vi.waitFor(() => expect(screen.getByText(/Delete failed:/)).toBeInTheDocument());
  });

  it("covers custom metadata parser edge cases and inline folder buttons", async () => {
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue(null);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

    // 2. メタデータ boolean パーサーや sort などのパーサー関数のエッジケースカバー
    // pageQuery のカスタムメタデータをモック
    const pageQueryResult = {
      data: {
        slug: "docs/getting-started",
        title: "Getting Started",
        body: "test body",
        meta: {
          showOnMenu: "false", // string boolean
          showOnHome: 0, // number boolean
          sort: "not-an-integer-string", // invalid integer
          tags: "tag1, tag2", // string comma list
          customKey: "custom-val", // custom meta
        },
      },
      isLoading: false,
      isError: false,
    } as any;
    const pageTreeQueryResult = { data: mockTree, isLoading: false, isError: false } as any;
    const healthQueryResult = {
      data: { ...mockHealth, git: null },
      isLoading: false,
      isError: false,
    } as any;
    const emptyQueryResult = { data: null, isLoading: false, isError: false } as any;
    vi.mocked(useQuery).mockImplementation(({ queryKey }: any) => {
      if (queryKey[0] === "page") {
        return pageQueryResult;
      }
      if (queryKey[0] === "page-tree") {
        return pageTreeQueryResult;
      }
      if (queryKey[0] === "health") {
        return healthQueryResult; // git が無いケース
      }
      return emptyQueryResult;
    });

    render(
      <QueryClientProvider client={queryClient}>
        <SourcesPage />
      </QueryClientProvider>,
    );

    // ツリーのロード完了を待つ
    const folderNode = await screen.findByText("docs");
    fireEvent.click(folderNode);

    // インラインフォルダ操作ボタンのシミュレート (New folder in docs, Rename folder docs, Delete folder docs)
    const inlineNewFolderBtn = await screen.findByTitle("New folder in docs");
    fireEvent.click(inlineNewFolderBtn);

    const inlineRenameFolderBtn = screen.getByTitle("Rename folder docs");
    fireEvent.click(inlineRenameFolderBtn);

    const inlineDeleteFolderBtn = screen.getByTitle("Delete folder docs");
    fireEvent.click(inlineDeleteFolderBtn);
    expect(promptSpy).toHaveBeenCalled();
    expect(confirmSpy).toHaveBeenCalled();
  });

  it("covers search page no results and API unavailable scenarios", async () => {
    // 3. 検索結果がないケースや、API unavailability のケース
    const searchQueryResult = {
      data: [],
      isLoading: false,
      isError: false,
      isFetching: false,
    } as any;
    const healthUnavailableResult = { data: null, isLoading: false, isError: true } as any;
    const pageTreeQueryResult = { data: mockTree, isLoading: false, isError: false } as any;
    const emptyQueryResult = { data: null, isLoading: false, isError: false } as any;
    vi.mocked(useQuery).mockImplementation(({ queryKey }: any) => {
      if (queryKey[0] === "search" && queryKey[1] === "no-results-query") {
        return searchQueryResult;
      }
      if (queryKey[0] === "health") {
        return healthUnavailableResult; // API unavailable
      }
      if (queryKey[0] === "page-tree") {
        return pageTreeQueryResult;
      }
      return emptyQueryResult;
    });

    render(
      <QueryClientProvider client={queryClient}>
        <SourcesPage />
      </QueryClientProvider>,
    );

    await vi.waitFor(() => expect(screen.getByText("API: unavailable")).toBeInTheDocument());

    const searchInput = screen.getByPlaceholderText("Search title/body");
    fireEvent.change(searchInput, { target: { value: "no-results-query" } });
    await vi.waitFor(() => expect(screen.getByText("no result")).toBeInTheDocument());
  });

  it("covers folder drag and drop self or subfolder move edge cases", async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <SourcesPage />
      </QueryClientProvider>,
    );

    // 4. ドラッグ＆ドロップでフォルダをフォルダに移動する操作のエッジケース
    const folderItem = await screen.findByText("docs");
    const folderContainer = folderItem.closest('[role="treeitem"]');
    if (folderContainer) {
      // 自身への移動
      const dropEventSelf = {
        preventDefault: vi.fn(),
        dataTransfer: {
          getData: vi.fn().mockReturnValue(JSON.stringify({ kind: "folder", path: "docs" })),
        },
      };
      fireEvent.drop(folderContainer, dropEventSelf);
      await vi.waitFor(() =>
        expect(screen.getByText("cannot move a folder into itself")).toBeInTheDocument(),
      );

      // 自身の中への移動 (親子関係)
      const dropEventSub = {
        preventDefault: vi.fn(),
        dataTransfer: {
          getData: vi.fn().mockReturnValue(JSON.stringify({ kind: "folder", path: "docs/sub" })),
        },
      };
      fireEvent.drop(folderContainer, dropEventSub);
    }
  });
});
