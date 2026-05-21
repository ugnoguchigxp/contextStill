/** @vitest-environment jsdom */
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import React from "react";
import { VibeMemoryPage } from "../../../web/src/modules/admin/components/vibe-memory.page";
import { QueryClient, QueryClientProvider, useQuery, useMutation } from "@tanstack/react-query";

// 外部ライブラリのモック
vi.mock("markdown-wysiwyg-editor", () => ({
  MarkdownEditor: ({ value }: { value: string }) => (
    <div data-testid="markdown-editor">{value}</div>
  ),
}));

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
  },
}));

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual("@tanstack/react-query");
  return {
    ...actual,
    useQuery: vi.fn(),
    useMutation: vi.fn(),
  };
});

const queryClient = new QueryClient();

// テスト用モックデータ
const mockVibeMemories = [
  {
    id: "mem-1",
    sessionId: "session-1",
    memoryType: "vibe",
    createdAt: "2026-05-21T08:00:00.000Z",
    content:
      "USER: <USER_REQUEST>How do I test React components?</USER_REQUEST>\nASSISTANT: You can use React Testing Library.",
    metadata: {
      projectName: "Project Alpha",
      projectRoot: "/workspace/alpha",
      source: "Antigravity",
      sessionStartedAt: "2026-05-21T08:00:00.000Z",
      timestamp: "2026-05-21T08:00:00.000Z",
      toolCalls: [
        {
          name: "run_command",
          summary: "Run tests",
          commandLine: "bun test",
          cwd: "/workspace/alpha",
          contentPreview: "success",
          sourceTruncated: true,
          reconstructedFromFile: true,
        },
      ],
    },
  },
  {
    id: "mem-2",
    sessionId: "session-2",
    memoryType: "distilled",
    createdAt: "2026-05-20T10:00:00.000Z",
    content: "USER: ```markdown\n# GEMINI.md\nSome environment config\n```\nASSISTANT: I see.",
    metadata: {
      projectName: "Project Beta",
      projectRoot: "/workspace/beta",
      source: "Manual",
      sessionStartedAt: "2026-05-20T10:00:00.000Z",
      timestamp: "2026-05-20T10:00:00.000Z",
    },
  },
];

const mockAgentDiffEntries = [
  {
    id: "diff-1",
    vibeMemoryId: "mem-1",
    filePath: "src/main.ts",
    diffHunk: "@@ -1,3 +1,4 @@\n+const a = 1;",
    symbolName: "a",
    symbolKind: "constant",
    changeType: "add",
  },
];

describe("VibeMemoryPage", () => {
  const mockMutate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();

    // デフォルトの useQuery / useMutation モック実装
    vi.mocked(useQuery).mockImplementation((options: any) => {
      if (options.queryKey[0] === "vibe-memories") {
        return { data: mockVibeMemories, isLoading: false, isError: false } as any;
      }
      if (options.queryKey[0] === "agent-diffs") {
        return { data: mockAgentDiffEntries, isLoading: false, isError: false } as any;
      }
      return { data: undefined, isLoading: false } as any;
    });

    vi.mocked(useMutation).mockReturnValue({
      mutate: mockMutate,
    } as any);
  });

  it("renders vibe memories sessions and detail correctly", () => {
    render(
      <QueryClientProvider client={queryClient}>
        <VibeMemoryPage />
      </QueryClientProvider>,
    );

    // セッション一覧の確認
    expect(screen.getByText(/Vibe Sessions/i)).toBeInTheDocument();

    // セッション1のタイトルまたはファーストメッセージが表示されていること
    expect(screen.getAllByText("How do I test React components?").length).toBeGreaterThanOrEqual(1);
    // セッション1のプロジェクト名、メタ情報
    expect(screen.getByText("Project Alpha")).toBeInTheDocument();
    expect(screen.getByText("Antigravity")).toBeInTheDocument();
    expect(screen.getAllByText("1 vibes").length).toBeGreaterThanOrEqual(1);

    // セッション2のプロジェクト名、メタ情報もセッションリストにあること
    expect(screen.getAllByText("Project Beta").length).toBeGreaterThanOrEqual(1);

    // デフォルトで最新セッション（session-1）がアクティブ表示されていること
    expect(screen.getAllByText("/workspace/alpha").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("You can use React Testing Library.")).toBeInTheDocument();
  });

  it("switches session when side item is clicked", () => {
    render(
      <QueryClientProvider client={queryClient}>
        <VibeMemoryPage />
      </QueryClientProvider>,
    );

    // セッション2のボタンを探してクリック
    const session2Btn = screen
      .getAllByRole("button")
      .find((btn) => btn.className.includes("session-item") && btn.title === "session-2");
    expect(session2Btn).toBeDefined();
    if (!session2Btn) {
      throw new Error("session2Btn is not defined");
    }

    fireEvent.click(session2Btn);

    // セッション2の詳細（Project Beta, 環境・設定メタデータなど）が表示されていること
    expect(screen.getByText("/workspace/beta")).toBeInTheDocument();
    expect(screen.getByText("環境・設定メタデータ")).toBeInTheDocument();
  });

  it("displays Tool Usage and Agent Diff sections and expands them", () => {
    render(
      <QueryClientProvider client={queryClient}>
        <VibeMemoryPage />
      </QueryClientProvider>,
    );

    // Tool Usageアコーディオンの存在確認
    expect(screen.getByText("Tool Usage")).toBeInTheDocument();
    expect(screen.getByText("run_command")).toBeInTheDocument();
    expect(screen.getByText("Run tests")).toBeInTheDocument();
    expect(screen.getByText("bun test")).toBeInTheDocument();
    expect(screen.getAllByText("/workspace/alpha").length).toBeGreaterThanOrEqual(1);
    expect(
      screen.getByText(
        "Antigravity のログは省略されていましたが、現在のファイル内容から展開しています。",
      ),
    ).toBeInTheDocument();

    // Agent Diffアコーディオンの存在確認
    expect(screen.getByText("Agent Diff")).toBeInTheDocument();
    // ファイル名（フォーマット後）が表示されていること
    expect(screen.getByText("main.ts")).toBeInTheDocument();
    // シンボル情報
    expect(screen.getByText("constant: a")).toBeInTheDocument();
    expect(screen.getByText("src/main.ts")).toBeInTheDocument();
    expect(screen.getByText(/const a = 1/)).toBeInTheDocument();
  });

  it("shows empty state when there are no vibe memories", () => {
    vi.mocked(useQuery).mockImplementation((options: any) => {
      if (options.queryKey[0] === "vibe-memories") {
        return { data: [], isLoading: false, isError: false } as any;
      }
      return { data: undefined, isLoading: false } as any;
    });

    render(
      <QueryClientProvider client={queryClient}>
        <VibeMemoryPage />
      </QueryClientProvider>,
    );

    expect(screen.getByText("No sessions found")).toBeInTheDocument();
    expect(screen.getByText("セッションを選択してください")).toBeInTheDocument();
  });

  it("handles deletion confirmation and success properly", () => {
    const confirmSpy = vi.spyOn(window, "confirm");

    render(
      <QueryClientProvider client={queryClient}>
        <VibeMemoryPage />
      </QueryClientProvider>,
    );

    const deleteBtn = screen.getByText("Delete");

    // キャンセルした場合
    confirmSpy.mockReturnValue(false);
    fireEvent.click(deleteBtn);
    expect(confirmSpy).toHaveBeenCalledWith("Delete this memory record?");
    expect(mockMutate).not.toHaveBeenCalled();

    // 承諾した場合
    confirmSpy.mockReturnValue(true);
    fireEvent.click(deleteBtn);
    expect(mockMutate).toHaveBeenCalledWith("mem-1");
  });
});
