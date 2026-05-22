import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type CompileRequest,
  type CompileRunKnowledgeFeedbackWriteItem,
  compilePack,
  fetchRecentRuns,
  fetchRunDetail,
  submitRunKnowledgeFeedback,
} from "../repositories/context-compiler.repository";

export function useCompileRuns(limit = 20) {
  return useQuery({
    queryKey: ["compile-runs", limit],
    queryFn: () => fetchRecentRuns(limit),
  });
}

export function useCompilePack() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CompileRequest) => compilePack(input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["compile-runs"] });
    },
  });
}

export function useCompileRunDetail(runId: string | null) {
  return useQuery({
    queryKey: ["compile-run-detail", runId],
    queryFn: () => fetchRunDetail(runId as string),
    enabled: Boolean(runId),
  });
}

export function useRunKnowledgeFeedbackMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { runId: string; items: CompileRunKnowledgeFeedbackWriteItem[] }) =>
      submitRunKnowledgeFeedback(input.runId, input.items),
    onSuccess: async (_data, variables) => {
      await queryClient.invalidateQueries({ queryKey: ["compile-run-detail", variables.runId] });
    },
  });
}
