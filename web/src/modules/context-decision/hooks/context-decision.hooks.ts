import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type ContextDecisionRequest,
  createContextDecision,
  fetchContextDecisionDetail,
  fetchContextDecisionRuns,
  submitContextDecisionHumanFeedback,
} from "../repositories/context-decision.repository";

export function useContextDecisionRuns(limit = 30) {
  return useQuery({
    queryKey: ["context-decisions", limit],
    queryFn: () => fetchContextDecisionRuns(limit),
  });
}

export function useContextDecisionDetail(decisionId: string | null) {
  return useQuery({
    queryKey: ["context-decision-detail", decisionId],
    queryFn: () => fetchContextDecisionDetail(decisionId as string),
    enabled: Boolean(decisionId),
  });
}

export function useCreateContextDecisionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ContextDecisionRequest) => createContextDecision(input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["context-decisions"] });
    },
  });
}

export function useContextDecisionFeedbackMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { decisionId: string; value: "good" | "bad" }) =>
      submitContextDecisionHumanFeedback(input.decisionId, input.value),
    onSuccess: async (_data, variables) => {
      await queryClient.invalidateQueries({ queryKey: ["context-decisions"] });
      await queryClient.invalidateQueries({
        queryKey: ["context-decision-detail", variables.decisionId],
      });
    },
  });
}
