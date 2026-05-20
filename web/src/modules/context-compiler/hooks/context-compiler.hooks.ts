import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  compilePack,
  fetchRunDetail,
  fetchRecentRuns,
  type CompileRequest,
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
