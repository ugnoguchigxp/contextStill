import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import {
  ContextDecisionFeedbackError,
  recordContextDecisionFeedback,
} from "../../../src/modules/context-decision/context-decision.feedback.service.js";
import { scanContextDecisionPrDiscards } from "../../../src/modules/context-decision/context-decision.pr-discard.service.js";
import {
  decideContext,
  getContextDecisionDetail,
  listContextDecisionRuns,
} from "../../../src/modules/context-decision/context-decision.service.js";
import {
  contextDecisionHumanFeedbackWriteSchema,
  contextDecisionIdParamSchema,
  contextDecisionInputSchema,
  contextDecisionListQuerySchema,
} from "../../../src/shared/schemas/context-decision.schema.js";

const contextDecisionSystemFeedbackWriteSchema = z.object({
  source: z.enum(["human", "ai", "system"]).default("system"),
  value: z.enum(["good", "bad"]).optional(),
  outcome: z
    .enum([
      "success",
      "failed",
      "discarded_pr",
      "user_overrode",
      "regression_found",
      "still_unknown",
    ])
    .default("still_unknown"),
  reason: z.string().optional(),
  metadata: z.record(z.unknown()).default({}),
});

export const contextDecisionRouter = new Hono()
  .post("/", zValidator("json", contextDecisionInputSchema), async (c) => {
    const result = await decideContext(c.req.valid("json"));
    return c.json(result);
  })
  .get("/", zValidator("query", contextDecisionListQuerySchema), async (c) => {
    const decisions = await listContextDecisionRuns(c.req.valid("query"));
    return c.json({ decisions });
  })
  .get("/:id", zValidator("param", contextDecisionIdParamSchema), async (c) => {
    const detail = await getContextDecisionDetail(c.req.valid("param").id);
    if (!detail) return c.json({ error: "Context decision not found." }, 404);
    return c.json({ detail });
  })
  .post(
    "/:id/human-feedback",
    zValidator("param", contextDecisionIdParamSchema),
    zValidator("json", contextDecisionHumanFeedbackWriteSchema),
    async (c) => {
      try {
        const { id } = c.req.valid("param");
        const { value } = c.req.valid("json");
        const result = await recordContextDecisionFeedback({
          decisionId: id,
          source: "human",
          value,
          metadata: {},
        });
        const detail = await getContextDecisionDetail(id);
        return c.json({ feedback: result, detail });
      } catch (error) {
        if (error instanceof ContextDecisionFeedbackError) {
          return c.json({ error: error.message }, error.statusCode === 404 ? 404 : 400);
        }
        throw error;
      }
    },
  )
  .post(
    "/:id/system-feedback",
    zValidator("param", contextDecisionIdParamSchema),
    zValidator("json", contextDecisionSystemFeedbackWriteSchema),
    async (c) => {
      try {
        const { id } = c.req.valid("param");
        const body = c.req.valid("json");
        const result = await recordContextDecisionFeedback({
          ...body,
          decisionId: id,
          source: body.source === "human" ? "system" : body.source,
        });
        return c.json(result);
      } catch (error) {
        if (error instanceof ContextDecisionFeedbackError) {
          return c.json({ error: error.message }, error.statusCode === 404 ? 404 : 400);
        }
        throw error;
      }
    },
  )
  .post("/pr-discard-scan", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = z
      .object({
        apply: z.boolean().default(false),
        since: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional(),
      })
      .safeParse(body);
    if (!parsed.success) return c.json({ error: "Invalid PR discard scan input." }, 400);
    const result = await scanContextDecisionPrDiscards(parsed.data);
    return c.json(result);
  });
