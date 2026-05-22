import { z } from "zod";
import { compileInputSchema } from "../../../src/shared/schemas/compile.schema.js";
import {
  compileRunKnowledgeFeedbackResultSchema,
  compileRunKnowledgeFeedbackWriteSchema,
} from "../../../src/shared/schemas/compile-run.schema.js";
import {
  compilePack,
  getRunDetail,
  listRuns,
  saveRunKnowledgeFeedback,
} from "./context-compiler.repository.js";

export const listRunsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const getRunDetailParamSchema = z.object({
  id: z.string().uuid(),
});

export const runKnowledgeFeedbackParamSchema = z.object({
  id: z.string().uuid(),
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

export async function saveRunKnowledgeFeedbackForApi(paramsInput: unknown, bodyInput: unknown) {
  const params = runKnowledgeFeedbackParamSchema.parse(paramsInput);
  const body = compileRunKnowledgeFeedbackWriteSchema.parse(bodyInput);
  const result = await saveRunKnowledgeFeedback({
    runId: params.id,
    items: body.items,
  });
  return compileRunKnowledgeFeedbackResultSchema.parse(result);
}
