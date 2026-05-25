import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { distillationTargetKindValues } from "../../../src/db/schema.js";
import {
  CoverEvidenceReprocessError,
  requestCoverEvidenceReprocess,
} from "../../../src/modules/coverEvidence/reprocess-candidate.service.js";
import {
  candidateListSortByValues,
  candidateOutcomeValues,
  listCandidateItems,
} from "./candidates.repository.js";

const candidateTargetKindFilterValues = ["all", ...distillationTargetKindValues] as const;

const candidateQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  query: z.string().trim().max(200).optional(),
  targetKind: z.enum(candidateTargetKindFilterValues).default("all"),
  outcome: z.enum(["all", ...candidateOutcomeValues]).default("all"),
  hasKnowledge: z.enum(["all", "yes", "no"]).default("all"),
  targetStateId: z.string().trim().min(1).optional(),
  sortBy: z.enum(candidateListSortByValues).default("latestUpdatedAt"),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
});

const candidateIdParamSchema = z.object({
  id: z.string().trim().min(1),
});

const premiumReprocessBodySchema = z
  .object({
    mode: z.enum(["cloud_api"]).optional(),
    forceRefreshEvidence: z.boolean().optional(),
  })
  .default({});

export const candidatesRouter = new Hono()
  .get("/", zValidator("query", candidateQuerySchema), async (c) => {
    const query = c.req.valid("query");
    const result = await listCandidateItems({
      page: query.page,
      limit: query.limit,
      query: query.query,
      targetKind: query.targetKind,
      outcome: query.outcome,
      hasKnowledge: query.hasKnowledge,
      targetStateId: query.targetStateId,
      sortBy: query.sortBy,
      sortDir: query.sortDir,
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
  })
  .post("/:id/premium-reprocess", zValidator("param", candidateIdParamSchema), async (c) => {
    let rawBody: unknown = {};
    const rawText = await c.req.text();
    if (rawText.trim().length > 0) {
      try {
        rawBody = JSON.parse(rawText);
      } catch {
        return c.json({ reason: "invalid_request_body" }, 400);
      }
    }
    const parsedBody = premiumReprocessBodySchema.safeParse(rawBody);
    if (!parsedBody.success) {
      return c.json({ reason: "invalid_request_body" }, 400);
    }
    const params = c.req.valid("param");

    try {
      const result = await requestCoverEvidenceReprocess({
        findCandidateResultId: params.id,
        mode: parsedBody.data.mode ?? "cloud_api",
        forceRefreshEvidence: parsedBody.data.forceRefreshEvidence ?? true,
        actor: "user",
      });
      return c.json({ result });
    } catch (error) {
      if (error instanceof CoverEvidenceReprocessError) {
        return c.json({ reason: error.reason }, error.statusCode);
      }
      throw error;
    }
  });
