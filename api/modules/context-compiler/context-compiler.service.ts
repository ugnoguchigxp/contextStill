import { z } from "zod";
import {
  compileRunEpisodeFeedbackResultSchema,
  compileRunEpisodeFeedbackWriteSchema,
  compileRunKnowledgeFeedbackResultSchema,
  compileRunKnowledgeFeedbackWriteSchema,
} from "../../../src/shared/schemas/compile-run.schema.js";
import { compileInputSchema } from "../../../src/shared/schemas/compile.schema.js";
import {
  compilePack,
  deprecateRunEpisodeForRepository,
  getRunDetail,
  getRunRankingTrace,
  listRuns,
  saveRunEpisodeFeedbackForRepository,
  saveRunKnowledgeFeedback,
} from "./context-compiler.repository.js";

export const listRunsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const getRunDetailParamSchema = z.object({
  id: z.string().uuid(),
});

export const getRunRankingTraceParamSchema = z.object({
  id: z.string().uuid(),
});

export const runKnowledgeFeedbackParamSchema = z.object({
  id: z.string().uuid(),
});

export const runEpisodeFeedbackParamSchema = z.object({
  id: z.string().uuid(),
});

export const runEpisodeDeprecateParamSchema = z.object({
  id: z.string().uuid(),
  episodeId: z.string().trim().min(1),
});

export async function compilePackForApi(input: unknown) {
  const parsed = compileInputSchema.parse(input);
  return compilePack(parsed);
}

export async function listRunsForApi(input: unknown) {
  const parsed = listRunsQuerySchema.parse(input);
  return listRuns(parsed.limit);
}

export async function getRunDetailForApi(input: unknown) {
  const parsed = getRunDetailParamSchema.parse(input);
  return getRunDetail(parsed.id);
}

export async function getRunRankingTraceForApi(input: unknown) {
  const parsed = getRunRankingTraceParamSchema.parse(input);
  return getRunRankingTrace(parsed.id);
}

export async function saveRunKnowledgeFeedbackForApi(paramsInput: unknown, bodyInput: unknown) {
  const params = runKnowledgeFeedbackParamSchema.parse(paramsInput);
  const body = compileRunKnowledgeFeedbackWriteSchema.parse(bodyInput);
  const result = await saveRunKnowledgeFeedback({
    runId: params.id,
    items: body.items,
  });
  return compileRunKnowledgeFeedbackResultSchema.parse(result);
}

export async function saveRunEpisodeFeedbackForApi(paramsInput: unknown, bodyInput: unknown) {
  const params = runEpisodeFeedbackParamSchema.parse(paramsInput);
  const body = compileRunEpisodeFeedbackWriteSchema.parse(bodyInput);
  const result = await saveRunEpisodeFeedbackForRepository({
    runId: params.id,
    items: body.items,
  });
  return compileRunEpisodeFeedbackResultSchema.parse(result);
}

export async function deprecateRunEpisodeForApi(paramsInput: unknown) {
  const params = runEpisodeDeprecateParamSchema.parse(paramsInput);
  await deprecateRunEpisodeForRepository({ runId: params.id, episodeId: params.episodeId });
  return { ok: true };
}
