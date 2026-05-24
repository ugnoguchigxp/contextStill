import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import {
  distillationTargetKindValues,
  distillationTargetStatusValues,
} from "../../../src/db/schema.js";
import {
  fetchQueueDashboardStats,
  listQueueItems,
  fetchActiveTasks,
  pauseTarget,
  resumeTarget,
} from "./queue.repository.js";

export const queueRouter = new Hono();

const queueTargetKindFilterValues = ["all", ...distillationTargetKindValues] as const;
const queueTargetStatusFilterValues = ["all", ...distillationTargetStatusValues] as const;

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  query: z.string().trim().max(200).optional(),
  targetKind: z.enum(queueTargetKindFilterValues).default("all"),
  status: z.enum(queueTargetStatusFilterValues).default("all"),
});
const targetIdParamSchema = z.object({ id: z.string().trim().min(1) });
const pauseBodySchema = z.object({
  reason: z.string().trim().min(1).max(300).optional().default("paused from visual dashboard"),
});

queueRouter.get("/", zValidator("query", listQuerySchema), async (c) => {
  const params = c.req.valid("query");
  const result = await listQueueItems(params);
  return c.json(result);
});

queueRouter.get("/stats", async (c) => {
  const result = await fetchQueueDashboardStats();
  return c.json(result);
});

queueRouter.get("/active", async (c) => {
  const result = await fetchActiveTasks();
  return c.json(result);
});

queueRouter.post(
  "/:id/pause",
  zValidator("param", targetIdParamSchema),
  zValidator("json", pauseBodySchema),
  async (c) => {
    const { id } = c.req.valid("param");
    const { reason } = c.req.valid("json");
    const result = await pauseTarget(id, reason);
    if (!result) {
      return c.json({ error: "Target state not found or unable to pause" }, 404);
    }
    return c.json({ ok: true, item: result });
  },
);

queueRouter.post("/:id/resume", zValidator("param", targetIdParamSchema), async (c) => {
  const { id } = c.req.valid("param");
  const result = await resumeTarget(id);
  if (!result) {
    return c.json({ error: "Target state not found or unable to resume" }, 404);
  }
  return c.json({ ok: true, item: result });
});
