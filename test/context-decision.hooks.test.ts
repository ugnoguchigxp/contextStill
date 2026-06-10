import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  useContextDecisionDetail,
  useContextDecisionFeedbackMutation,
  useContextDecisionRuns,
  useCreateContextDecisionMutation,
} from "../web/src/modules/context-decision/hooks/context-decision.hooks.js";

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
const mockFetchContextDecisionRuns = vi.fn();
const mockFetchContextDecisionDetail = vi.fn();
const mockCreateContextDecision = vi.fn();
const mockSubmitContextDecisionHumanFeedback = vi.fn();

vi.mock("../web/src/modules/context-decision/repositories/context-decision.repository", () => ({
  fetchContextDecisionRuns: (...args: any[]) => mockFetchContextDecisionRuns(...args),
  fetchContextDecisionDetail: (...args: any[]) => mockFetchContextDecisionDetail(...args),
  createContextDecision: (...args: any[]) => mockCreateContextDecision(...args),
  submitContextDecisionHumanFeedback: (...args: any[]) =>
    mockSubmitContextDecisionHumanFeedback(...args),
}));

describe("context-decision.hooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("useContextDecisionRuns calls fetchContextDecisionRuns", () => {
    useContextDecisionRuns(20);
    expect(mockFetchContextDecisionRuns).toHaveBeenCalledWith(20);
  });

  test("useContextDecisionDetail calls fetchContextDecisionDetail", () => {
    useContextDecisionDetail("dec-123");
    expect(mockFetchContextDecisionDetail).toHaveBeenCalledWith("dec-123");
  });

  test("useCreateContextDecisionMutation calls createContextDecision and invalidates queries on success", async () => {
    const mutation = useCreateContextDecisionMutation();
    const mockInput = { some: "data" } as any;
    mutation.mutate(mockInput);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockCreateContextDecision).toHaveBeenCalledWith(mockInput);
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["context-decisions"] });
  });

  test("useContextDecisionFeedbackMutation calls submitContextDecisionHumanFeedback and invalidates queries on success", async () => {
    const mutation = useContextDecisionFeedbackMutation();
    mutation.mutate({ decisionId: "dec-123", value: "good" });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockSubmitContextDecisionHumanFeedback).toHaveBeenCalledWith("dec-123", "good");
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["context-decisions"] });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ["context-decision-detail", "dec-123"],
    });
  });
});
