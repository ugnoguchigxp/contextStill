import { useMutation, useQuery } from "@tanstack/react-query";
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

const routerState = vi.hoisted(() => ({
  searchStr: "?goalId=goal-1",
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

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn(),
  useMutation: vi.fn().mockReturnValue({
    mutate: vi.fn(),
    isLoading: false,
  }),
  useQueryClient: vi.fn().mockReturnValue({
    invalidateQueries: vi.fn(),
  }),
}));

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

const mockVibeGoals = [
  {
    id: "goal-1",
    goalUri: "repo://myorg/myrepo/plan.md",
    goalAnchorRef: "/Users/y.noguchi/Code/memoryRouter/plan.md",
    title: "Implement Kanban Board",
    createdAt: "2026-05-27T05:00:00.000Z",
  },
];

const mockVibeContext = {
  brief: "# Room Brief\nThis is a brief",
  openLoops: [
    {
      id: "loop-1",
      intent: "ask",
      text: "Unresolved task: Add unit tests",
      subject: "test/vibe-memory.test.ts",
      wants: ["review"],
      refs: ["file:///Users/y.noguchi/Code/memoryRouter/plan.md"],
      score: 120,
      evidenceStatus: "ungrounded",
      actorId: "agent-1",
      createdAt: "2026-05-26T05:00:00.000Z",
      marks: [],
    },
  ],
  agentMemos: [
    {
      id: "memo-1",
      intent: "finding",
      text: "Agent memo: keep Vibe Memory free of raw capsules",
      subject: "vibe-note",
      wants: [],
      refs: ["file:///Users/y.noguchi/Code/memoryRouter/vibe-note.md"],
      score: 0,
      evidenceStatus: "referenced",
      actorId: "agent-vibe",
      createdAt: "2026-05-26T06:00:00.000Z",
      marks: [],
    },
  ],
  recentTimeline: [
    {
      id: "memo-1",
      intent: "finding",
      text: "Agent memo: keep Vibe Memory free of raw capsules",
      subject: "vibe-note",
      wants: [],
      refs: [],
      score: 0,
      evidenceStatus: "referenced",
      actorId: "agent-vibe",
      createdAt: "2026-05-26T06:00:00.000Z",
      marks: [],
    },
  ],
  pinned: [
    {
      id: "pin-1",
      text: "Checkpoint: Schema finalized",
      actorId: "agent-1",
      createdAt: "2026-05-26T05:00:00.000Z",
      refs: [],
    },
  ],
  decisions: [
    {
      id: "dec-1",
      text: "Decision: Use SHA-256 for goalId",
      actorId: "agent-1",
      createdAt: "2026-05-26T05:00:00.000Z",
      refs: [],
    },
  ],
};

describe("VibeNotePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-27T00:00:00.000Z"));
    setTimezoneSetting("UTC");

    vi.mocked(useQuery).mockImplementation((options: any) => {
      if (options.queryKey[0] === "vibe-goals") {
        return { data: mockVibeGoals, isLoading: false, isError: false } as any;
      }
      if (options.queryKey[0] === "vibe-memory-context") {
        return { data: mockVibeContext, isLoading: false, isError: false } as any;
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

    const button = screen.getByTitle("repo://myorg/myrepo/plan.md");
    const utcLabel = formatDateTimeCompact("2026-05-27T05:00:00.000Z", "UTC");
    const tokyoLabel = formatDateTimeCompact("2026-05-27T05:00:00.000Z", "Asia/Tokyo");

    expect(within(button).getByText(utcLabel)).toBeInTheDocument();

    await act(async () => {
      setTimezoneSetting("Asia/Tokyo");
    });

    expect(within(button).getByText(tokyoLabel)).toBeInTheDocument();
  });

  it("renders Room Brief and Unresolved Open Loops", () => {
    render(<VibeNotePage />);

    // Check Room Brief is loaded
    expect(screen.getByText(/This is a brief/)).toBeInTheDocument();

    // Check Kanban card
    expect(screen.getByText(/Add unit tests/)).toBeInTheDocument();
    expect(screen.getByText(/test\/vibe-memory\.test\.ts/)).toBeInTheDocument();
    expect(screen.getByText("未検証")).toBeInTheDocument();
  });

  it("renders non-loop capsules as agent memos", () => {
    render(<VibeNotePage />);

    expect(screen.getByText("Agent Memos (1)")).toBeInTheDocument();
    expect(screen.getAllByText(/keep Vibe Memory free of raw capsules/).length).toBeGreaterThan(0);
    expect(screen.getAllByText("finding").length).toBeGreaterThan(0);
  });

  it("renders match badge for high score loops", () => {
    render(<VibeNotePage />);
    expect(screen.getByText("🔥 MATCH")).toBeInTheDocument();
  });
});
