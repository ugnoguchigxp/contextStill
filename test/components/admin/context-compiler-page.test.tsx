/** @vitest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { ContextCompilerPage } from "../../../web/src/modules/context-compiler/components/context-compiler.page";
import * as hooks from "../../../web/src/modules/context-compiler/hooks/context-compiler.hooks";

vi.mock("../../../web/src/modules/context-compiler/hooks/context-compiler.hooks", () => ({
  useCompilePack: vi.fn(),
  useCompileRunDetail: vi.fn(),
  useCompileRuns: vi.fn(),
  useRunKnowledgeFeedbackMutation: vi.fn(),
}));

const mockedHooks = vi.mocked(hooks);

function setupHooks() {
  mockedHooks.useCompilePack.mockReturnValue({
    isPending: false,
    error: null,
    mutateAsync: vi.fn(),
  } as unknown as ReturnType<typeof hooks.useCompilePack>);

  mockedHooks.useCompileRuns.mockReturnValue({
    data: [
      {
        id: "run-1",
        goal: "Run one",
        retrievalMode: "task_context",
        status: "ok",
        degradedReasons: [],
        durationMs: 123,
        source: "mcp",
        evalSummary: {
          count: 1,
          latestScore: 88,
          averageScore: 88,
          latestOutcome: "useful",
          latestEvaluatedAt: "2026-05-27T00:00:00.000Z",
        },
        createdAt: "2026-05-27T00:00:00.000Z",
      },
    ],
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof hooks.useCompileRuns>);

  mockedHooks.useCompileRunDetail.mockReturnValue({
    data: {
      run: {
        id: "run-1",
        goal: "Run one",
        retrievalMode: "task_context",
        status: "ok",
        degradedReasons: [],
        durationMs: 123,
        source: "mcp",
        evalSummary: {
          count: 1,
          latestScore: 88,
          averageScore: 88,
          latestOutcome: "useful",
          latestEvaluatedAt: "2026-05-27T00:00:00.000Z",
        },
        createdAt: "2026-05-27T00:00:00.000Z",
        tokenBudget: 2048,
        input: {},
      },
      pack: null,
      outputMarkdown: "No Content",
      selectedItems: [],
      knowledgeFeedback: [],
      knowledgeSignals: [],
      evaluations: [
        {
          id: "eval-1",
          runId: "run-1",
          sessionId: "s-1",
          score: 88,
          outcome: "useful",
          title: "Good context",
          body: "It reduced investigation time.",
          source: "mcp",
          createdAt: "2026-05-27T00:00:00.000Z",
          updatedAt: "2026-05-27T00:00:00.000Z",
        },
      ],
      snapshotAvailable: false,
    },
    isLoading: false,
    error: null,
  } as unknown as ReturnType<typeof hooks.useCompileRunDetail>);

  mockedHooks.useRunKnowledgeFeedbackMutation.mockReturnValue({
    isPending: false,
    mutateAsync: vi.fn(),
  } as unknown as ReturnType<typeof hooks.useRunKnowledgeFeedbackMutation>);
}

describe("ContextCompilerPage", () => {
  it("renders sidebar eval score and run detail evaluations", async () => {
    setupHooks();
    render(<ContextCompilerPage />);

    expect(screen.getByText("score 88 / useful")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /run one/i }));
    expect(screen.getByRole("heading", { name: "Compile Eval" })).toBeInTheDocument();
    expect(screen.getByText("Good context")).toBeInTheDocument();
    expect(screen.getByText("88 / Useful")).toBeInTheDocument();
  });
});
