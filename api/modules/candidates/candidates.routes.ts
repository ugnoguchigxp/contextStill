import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { candidateOutcomeValues, listCandidateItems } from "./candidates.repository.js";

const candidateQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  query: z.string().trim().max(200).optional(),
  targetKind: z.enum(["all", "wiki_file", "vibe_memory"]).default("all"),
  outcome: z.enum(["all", ...candidateOutcomeValues]).default("all"),
  hasKnowledge: z.enum(["all", "yes", "no"]).default("all"),
  targetStateId: z.string().trim().min(1).optional(),
});

export const candidatesRouter = new Hono().get(
  "/",
  zValidator("query", candidateQuerySchema),
  async (c) => {
    const query = c.req.valid("query");
    const result = await listCandidateItems({
      page: query.page,
      limit: query.limit,
      query: query.query,
      targetKind: query.targetKind,
      outcome: query.outcome,
      hasKnowledge: query.hasKnowledge,
      targetStateId: query.targetStateId,
    });

    const totalPages = result.total === 0 ? 0 : Math.ceil(result.total / query.limit);
    return c.json({
      items: result.items,
      total: result.total,
      page: query.page,
      limit: query.limit,
      totalPages,
      stats: result.stats,
    });
  },
);
