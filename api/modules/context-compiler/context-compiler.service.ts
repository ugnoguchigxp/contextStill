import { z } from "zod";
import { compileInputSchema } from "../../../src/shared/schemas/compile.schema.js";
import { compilePack, getRunDetail, listRuns } from "./context-compiler.repository.js";

export const listRunsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const getRunDetailParamSchema = z.object({
  id: z.string().uuid(),
});

export async function compilePackForApi(input: unknown) {
  const parsed = compileInputSchema.parse(input);
  const result = await compilePack(parsed);
  return result.pack;
}

export async function listRunsForApi(input: unknown) {
  const parsed = listRunsQuerySchema.parse(input);
  return listRuns(parsed.limit);
}

export async function getRunDetailForApi(input: unknown) {
  const parsed = getRunDetailParamSchema.parse(input);
  return getRunDetail(parsed.id);
}
