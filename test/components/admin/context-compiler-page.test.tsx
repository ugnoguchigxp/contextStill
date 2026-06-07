/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { ContextCompilerPage } from "../../../web/src/modules/context-compiler/components/context-compiler.page";
import * as hooks from "../../../web/src/modules/context-compiler/hooks/context-compiler.hooks";

vi.mock("../../../web/src/modules/context-compiler/hooks/context-compiler.hooks", () => ({
  useCompilePack: vi.fn(),
  useCompileRunDetail: vi.fn(),
  useCompileRunRankingTrace: vi.fn(),
  useCompileRuns: vi.fn(),
  useDeprecateKnowledgeMutation: vi.fn(),
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
          latestAvg: 88,
          averageAvg: 88,
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
          latestAvg: 88,
          averageAvg: 88,
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
          avg: 88,
          outcome: "useful",
          title: "Good context",
          body: "It reduced investigation time.",
          source: "mcp",
          relevance: 90,
          actionability: 80,
          coverage: 70,
          clarity: 90,
          specificity: 80,
          createdAt: "2026-05-27T00:00:00.000Z",
          updatedAt: "2026-05-27T00:00:00.000Z",
        },
      ],
      snapshotAvailable: false,
    },
    isLoading: false,
    error: null,
  } as unknown as ReturnType<typeof hooks.useCompileRunDetail>);

  mockedHooks.useCompileRunRankingTrace.mockReturnValue({
    data: {
      run: {
        id: "run-1",
        goal: "Run one",
        repoPath: null,
        retrievalMode: "task_context",
        status: "ok",
        input: {},
        createdAt: "2026-05-27T00:00:00.000Z",
      },
      evalSummary: {
        count: 1,
        latestAvg: 88,
        latestOutcome: "useful",
      },
      feedbackSummary: {
        used: 1,
        notUsed: 0,
        offTopic: 0,
        wrong: 0,
        noSignal: 0,
      },
      funnel: {
        textHitCount: 1,
        vectorHitCount: 1,
        mergedCount: 1,
        finalCount: 1,
        packedCount: 1,
        selectedCount: 1,
        suppressedCount: 0,
      },
      items: [],
    },
    isLoading: false,
    error: null,
  } as unknown as ReturnType<typeof hooks.useCompileRunRankingTrace>);

  mockedHooks.useRunKnowledgeFeedbackMutation.mockReturnValue({
    isPending: false,
    mutateAsync: vi.fn(),
  } as unknown as ReturnType<typeof hooks.useRunKnowledgeFeedbackMutation>);

  mockedHooks.useDeprecateKnowledgeMutation.mockReturnValue({
    isPending: false,
    mutateAsync: vi.fn().mockResolvedValue(undefined),
  } as unknown as ReturnType<typeof hooks.useDeprecateKnowledgeMutation>);
}

describe("ContextCompilerPage", () => {
  it("renders sidebar eval score and run detail evaluations", async () => {
    setupHooks();
    render(<ContextCompilerPage />);

    expect(screen.getByTitle("Latest compile_eval avg score")).toHaveTextContent("88");

    fireEvent.click(screen.getByRole("button", { name: /run one/i }));
    expect(screen.getByRole("heading", { name: "Compile Eval" })).toBeInTheDocument();
    expect(screen.getByText("Good context")).toBeInTheDocument();
    expect(screen.getByText("Avg: 88 / Useful")).toBeInTheDocument();
  });

  it("shows 'Evaluation' when evaluation title is missing", async () => {
    setupHooks();
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
            latestAvg: 88,
            averageAvg: 88,
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
            avg: 88,
            outcome: "useful",
            title: null,
            body: "It reduced investigation time.",
            source: "mcp",
            relevance: 90,
            actionability: 80,
            coverage: 70,
            clarity: 90,
            specificity: 80,
            createdAt: "2026-05-27T00:00:00.000Z",
            updatedAt: "2026-05-27T00:00:00.000Z",
          },
        ],
        snapshotAvailable: false,
      },
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof hooks.useCompileRunDetail>);

    render(<ContextCompilerPage />);
    fireEvent.click(screen.getByRole("button", { name: /run one/i }));
    expect(screen.getByText("Evaluation")).toBeInTheDocument();
  });

  it("confirms before deprecating selected knowledge", async () => {
    setupHooks();
    const deprecateMutateAsync = vi.fn().mockResolvedValue(undefined);
    mockedHooks.useDeprecateKnowledgeMutation.mockReturnValue({
      isPending: false,
      mutateAsync: deprecateMutateAsync,
    } as unknown as ReturnType<typeof hooks.useDeprecateKnowledgeMutation>);
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
            count: 0,
            latestAvg: null,
            averageAvg: null,
            latestOutcome: null,
            latestEvaluatedAt: null,
          },
          createdAt: "2026-05-27T00:00:00.000Z",
          tokenBudget: 2048,
          input: {},
        },
        pack: {
          runId: "run-1",
          goal: "Run one",
          retrievalMode: "task_context",
          status: "ok",
          minimalTasks: [],
          rules: [
            {
              id: "knowledge:k-1",
              itemId: "550e8400-e29b-41d4-a716-446655440001",
              itemKind: "rule",
              title: "Project-specific rule",
              content: "Use only in one project.",
              score: 0.8,
              rankingReason: "test",
              sourceRefs: [],
            },
          ],
          procedures: [],
          warnings: [],
          sourceRefs: [],
          diagnostics: {
            degradedReasons: [],
            retrievalStats: {},
          },
        },
        outputMarkdown: "Compiled output",
        selectedItems: [],
        knowledgeFeedback: [],
        knowledgeSignals: [],
        evaluations: [],
        snapshotAvailable: true,
      },
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof hooks.useCompileRunDetail>);

    render(<ContextCompilerPage />);
    fireEvent.click(screen.getByRole("button", { name: /run one/i }));
    fireEvent.click(screen.getByRole("button", { name: "Deprecate" }));

    expect(deprecateMutateAsync).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toHaveTextContent("Deprecate selected knowledge?");

    fireEvent.click(screen.getByRole("button", { name: "Deprecate knowledge" }));

    await waitFor(() => {
      expect(deprecateMutateAsync).toHaveBeenCalledWith({
        runId: "run-1",
        knowledgeId: "550e8400-e29b-41d4-a716-446655440001",
      });
    });
  });
});
