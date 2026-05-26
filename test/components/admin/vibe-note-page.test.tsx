/** @vitest-environment jsdom */
import { act, render, screen, within } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatDateTime,
  formatDateTimeCompact,
  setTimezoneSetting,
} from "../../../web/src/lib/timezone";
import { VibeNotePage } from "../../../web/src/modules/admin/components/vibe-note.page";
import { useQuery } from "@tanstack/react-query";

const routerState = vi.hoisted(() => ({
  searchStr: "?sessionId=session-1",
}));

vi.mock("@tanstack/react-router", () => ({
  useRouterState: vi
    .fn()
    .mockImplementation(({ select }: any) =>
      typeof select === "function"
        ? select({ location: { searchStr: routerState.searchStr } })
        : routerState.searchStr,
    ),
}));

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual("@tanstack/react-query");
  return {
    ...actual,
    useQuery: vi.fn(),
  };
});

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

const mockMemoSessions = [
  {
    sessionId: "session-1",
    memoCount: 1,
    nonCompileResultMemoCount: 1,
    compileResultMemoCount: 0,
    compileOnly: false,
    lastUpdatedAt: "2026-05-27T05:00:00.000Z",
  },
];

const mockVibeMemories = [
  {
    id: "mem-1",
    sessionId: "session-1",
    memoryType: "vibe",
    createdAt: "2026-05-26T05:00:00.000Z",
    content: "USER: hello\nASSISTANT: hi",
    metadata: {
      projectName: "Project Alpha",
      source: "Codex",
      sessionStartedAt: "2026-05-26T05:00:00.000Z",
      timestamp: "2026-05-26T05:00:00.000Z",
    },
  },
];

const mockSessionMemos = [
  {
    slot: 0,
    kind: "compile_result",
    label: "compile_result:run-1",
    preview: "hello",
    createdAt: "2026-05-26T05:00:00.000Z",
    linkedGoal: "管理者自身 Score RankChart を変更して保存し、反映ズレを調査する",
    linkedOutputMarkdown: "# compile output",
    metadata: {},
  },
];

describe("VibeNotePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-27T00:00:00.000Z"));
    setTimezoneSetting("UTC");
    vi.mocked(useQuery).mockImplementation((options: any) => {
      if (options.queryKey[0] === "session-memo-sessions") {
        return { data: mockMemoSessions, isLoading: false, isError: false } as any;
      }
      if (options.queryKey[0] === "vibe-memories") {
        return { data: mockVibeMemories, isLoading: false, isError: false } as any;
      }
      if (options.queryKey[0] === "session-memos") {
        return { data: { items: mockSessionMemos }, isLoading: false, isError: false } as any;
      }
      return { data: undefined, isLoading: false, isError: false } as any;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    window.localStorage.clear();
  });

  it("uses the timezone setting for sidebar and note timestamps", async () => {
    render(<VibeNotePage />);

    const button = screen.getByTitle("session-1");
    const utcLabel = formatDateTimeCompact("2026-05-27T05:00:00.000Z", "UTC");
    const tokyoLabel = formatDateTimeCompact("2026-05-27T05:00:00.000Z", "Asia/Tokyo");

    expect(within(button).getByText(utcLabel)).toBeInTheDocument();

    await act(async () => {
      setTimezoneSetting("Asia/Tokyo");
    });

    expect(within(button).getByText(tokyoLabel)).toBeInTheDocument();
    expect(
      screen.getByText(formatDateTime("2026-05-26T05:00:00.000Z", "Asia/Tokyo")),
    ).toBeInTheDocument();
  });

  it("shows linked context compile goal inside each note slot", () => {
    render(<VibeNotePage />);
    expect(
      screen.getByText("管理者自身 Score RankChart を変更して保存し、反映ズレを調査する"),
    ).toBeInTheDocument();
    expect(screen.getByText("# compile output")).toBeInTheDocument();
  });

  it("shows Goal only for compile_result slots", () => {
    vi.mocked(useQuery).mockImplementation((options: any) => {
      if (options.queryKey[0] === "session-memo-sessions") {
        return { data: mockMemoSessions, isLoading: false, isError: false } as any;
      }
      if (options.queryKey[0] === "vibe-memories") {
        return { data: mockVibeMemories, isLoading: false, isError: false } as any;
      }
      if (options.queryKey[0] === "session-memos") {
        return {
          data: {
            items: [
              {
                slot: 0,
                kind: "compile_result",
                label: "compile_result:run-1",
                preview: "result",
                createdAt: "2026-05-26T05:00:00.000Z",
                linkedGoal: "compile-result-goal",
                linkedOutputMarkdown: "# compile output",
                metadata: {},
              },
              {
                slot: 1,
                kind: "compile_eval",
                label: "compile_eval:run-1:1",
                preview: "eval memo",
                createdAt: "2026-05-26T05:00:00.000Z",
                linkedGoal: "compile-eval-goal",
                metadata: { title: "eval", score: 90 },
              },
            ],
          },
          isLoading: false,
          isError: false,
        } as any;
      }
      return { data: undefined, isLoading: false, isError: false } as any;
    });

    render(<VibeNotePage />);

    expect(screen.getByText("compile-result-goal")).toBeInTheDocument();
    expect(screen.queryByText("compile-eval-goal")).not.toBeInTheDocument();
  });
});
