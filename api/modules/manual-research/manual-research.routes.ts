import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import {
  ManualResearchConflict,
  createManualResearch,
  createManualResearchSchema,
  getManualResearch,
  listManualResearch,
  reconcileManualResearch,
  reconcilePendingManualResearch,
  requestManualResearchCancel,
} from "../../../src/modules/manual-research/manual-research.service.js";

const idSchema = z.object({ id: z.string().uuid() });

export const manualResearchRouter = new Hono()
  .get("/", async (c) => {
    c.header("Cache-Control", "no-store");
    void reconcilePendingManualResearch().catch(() => {});
    return c.json({ runs: await listManualResearch() });
  })
  .post("/", zValidator("json", createManualResearchSchema), async (c) => {
    c.header("Cache-Control", "no-store");
    try {
      const run = await createManualResearch(c.req.valid("json"));
      return c.json({ run }, 201);
    } catch (error) {
      if (error instanceof ManualResearchConflict) return c.json({ error: error.message }, 409);
      throw error;
    }
  })
  .get("/:id", zValidator("param", idSchema), async (c) => {
    c.header("Cache-Control", "no-store");
    const id = c.req.valid("param").id;
    void reconcileManualResearch(id);
    const run = await getManualResearch(id);
    return run ? c.json({ run }) : c.json({ error: "NOT_FOUND" }, 404);
  })
  .post("/:id/cancel", zValidator("param", idSchema), async (c) => {
    c.header("Cache-Control", "no-store");
    const run = await requestManualResearchCancel(c.req.valid("param").id);
    return run ? c.json({ run }) : c.json({ error: "NOT_FOUND" }, 404);
  });
