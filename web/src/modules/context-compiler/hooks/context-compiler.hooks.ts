import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type CompileRequest,
  type CompileRunEpisodeFeedbackWriteItem,
  type CompileRunKnowledgeFeedbackWriteItem,
  compilePack,
  deprecateKnowledgeItem,
  deprecateRunEpisode,
  fetchRecentRuns,
  fetchRunDetail,
  fetchRunRankingTrace,
  submitRunEpisodeFeedback,
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

export function useCompileRunRankingTrace(runId: string | null) {
  return useQuery({
    queryKey: ["compile-run-ranking-trace", runId],
    queryFn: () => fetchRunRankingTrace(runId as string),
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
      await queryClient.invalidateQueries({
        queryKey: ["compile-run-ranking-trace", variables.runId],
      });
    },
  });
}

export function useRunEpisodeFeedbackMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { runId: string; items: CompileRunEpisodeFeedbackWriteItem[] }) =>
      submitRunEpisodeFeedback(input.runId, input.items),
    onSuccess: async (_data, variables) => {
      await queryClient.invalidateQueries({ queryKey: ["compile-run-detail", variables.runId] });
    },
  });
}

export function useDeprecateKnowledgeMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { runId: string; knowledgeId: string }) =>
      deprecateKnowledgeItem(input.knowledgeId),
    onSuccess: async (_data, variables) => {
      await queryClient.invalidateQueries({ queryKey: ["compile-run-detail", variables.runId] });
      await queryClient.invalidateQueries({
        queryKey: ["compile-run-ranking-trace", variables.runId],
      });
      await queryClient.invalidateQueries({ queryKey: ["knowledge"] });
      await queryClient.invalidateQueries({ queryKey: ["graph"] });
    },
  });
}

export function useDeprecateEpisodeMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { runId: string; episodeId: string }) =>
      deprecateRunEpisode(input.runId, input.episodeId),
    onSuccess: async (_data, variables) => {
      await queryClient.invalidateQueries({ queryKey: ["compile-run-detail", variables.runId] });
    },
  });
}
