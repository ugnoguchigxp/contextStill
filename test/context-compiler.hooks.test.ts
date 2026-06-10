import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  useCompilePack,
  useCompileRunDetail,
  useCompileRunRankingTrace,
  useCompileRuns,
  useDeprecateKnowledgeMutation,
  useRunKnowledgeFeedbackMutation,
} from "../web/src/modules/context-compiler/hooks/context-compiler.hooks.js";

// @tanstack/react-query のモック
const mockInvalidateQueries = vi.fn();
vi.mock("@tanstack/react-query", () => {
  return {
    useQuery: vi.fn((options: any) => {
      if (typeof options.queryFn === "function") {
        try {
          options.queryFn();
        } catch {}
      }
      return { data: "query-data", isLoading: false };
    }),
    useMutation: vi.fn((options: any) => {
      return {
        mutate: vi.fn((input: any) => {
          if (typeof options.mutationFn === "function") {
            options.mutationFn(input);
          }
          if (typeof options.onSuccess === "function") {
            options.onSuccess("data", input);
          }
        }),
      };
    }),
    useQueryClient: vi.fn(() => ({
      invalidateQueries: mockInvalidateQueries,
    })),
  };
});

// repository のモック
const mockFetchRecentRuns = vi.fn();
const mockCompilePack = vi.fn();
const mockFetchRunDetail = vi.fn();
const mockFetchRunRankingTrace = vi.fn();
const mockSubmitRunKnowledgeFeedback = vi.fn();
const mockDeprecateKnowledgeItem = vi.fn();

vi.mock("../web/src/modules/context-compiler/repositories/context-compiler.repository", () => ({
  fetchRecentRuns: (...args: any[]) => mockFetchRecentRuns(...args),
  compilePack: (...args: any[]) => mockCompilePack(...args),
  fetchRunDetail: (...args: any[]) => mockFetchRunDetail(...args),
  fetchRunRankingTrace: (...args: any[]) => mockFetchRunRankingTrace(...args),
  submitRunKnowledgeFeedback: (...args: any[]) => mockSubmitRunKnowledgeFeedback(...args),
  deprecateKnowledgeItem: (...args: any[]) => mockDeprecateKnowledgeItem(...args),
}));

describe("context-compiler.hooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("useCompileRuns calls fetchRecentRuns", () => {
    useCompileRuns(10);
    expect(mockFetchRecentRuns).toHaveBeenCalledWith(10);
  });

  test("useCompilePack calls compilePack and invalidates queries on success", async () => {
    const mutation = useCompilePack();
    mutation.mutate({ goal: "test-goal" } as any);

    // 非同期 onSuccess の完了を待つ
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockCompilePack).toHaveBeenCalledWith({ goal: "test-goal" });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["compile-runs"] });
  });

  test("useCompileRunDetail calls fetchRunDetail", () => {
    useCompileRunDetail("run-123");
    expect(mockFetchRunDetail).toHaveBeenCalledWith("run-123");
  });

  test("useCompileRunRankingTrace calls fetchRunRankingTrace", () => {
    useCompileRunRankingTrace("run-123");
    expect(mockFetchRunRankingTrace).toHaveBeenCalledWith("run-123");
  });

  test("useRunKnowledgeFeedbackMutation calls submitRunKnowledgeFeedback and invalidates details", async () => {
    const mutation = useRunKnowledgeFeedbackMutation();
    mutation.mutate({ runId: "run-123", items: [] });

    // 非同期 onSuccess の完了を待つ
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockSubmitRunKnowledgeFeedback).toHaveBeenCalledWith("run-123", []);
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ["compile-run-detail", "run-123"],
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ["compile-run-ranking-trace", "run-123"],
    });
  });

  test("useDeprecateKnowledgeMutation calls deprecateKnowledgeItem and invalidates queries", async () => {
    const mutation = useDeprecateKnowledgeMutation();
    mutation.mutate({ runId: "run-123", knowledgeId: "kb-1" });

    // 非同期 onSuccess の完了を待つ
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockDeprecateKnowledgeItem).toHaveBeenCalledWith("kb-1");
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ["compile-run-detail", "run-123"],
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ["compile-run-ranking-trace", "run-123"],
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["knowledge"] });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["graph"] });
  });
});
