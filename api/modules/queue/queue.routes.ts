import { Hono, type Context } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import {
  distillationQueueNameValues,
  distillationQueueStatusValues,
  type DistillationQueueName,
} from "../../../src/modules/queue/core/types.js";
import {
  fetchQueueDashboardStats,
  listQueueItems,
  fetchActiveTasks,
  pauseQueueLane,
  pauseTarget,
  resumeQueueLane,
  retryTarget,
  resumeTarget,
} from "./queue.repository.js";

export const queueRouter = new Hono();

const queueNameValues = distillationQueueNameValues;
const queueStatusFilterValues = ["all", ...distillationQueueStatusValues] as const;

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  query: z.string().trim().max(200).optional(),
  queue: z.enum(queueNameValues).default("findingCandidate"),
  status: z.enum(queueStatusFilterValues).default("all"),
});
const queueIdParamSchema = z.object({
  queue: z.enum(queueNameValues),
  id: z.string().trim().min(1),
});
const pauseBodySchema = z.object({
  reason: z.string().trim().min(1).max(300).optional().default("paused from visual dashboard"),
});
const laneControlBodySchema = z.object({
  reason: z.string().trim().min(1).max(300).optional(),
});
const retryBodySchema = z.object({
  mode: z.enum(["default", "cloud_api"]).default("default"),
  forceRefreshEvidence: z.boolean().default(true),
  reason: z.string().trim().max(300).optional(),
});

function isMissingRelationError(error: unknown): boolean {
  const queue: unknown[] = [error];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    if (typeof current === "string") {
      if (current.includes('relation "') && current.includes('" does not exist')) return true;
      continue;
    }
    if (current instanceof Error) {
      if (current.message.includes('relation "') && current.message.includes('" does not exist')) {
        return true;
      }
      const coded = current as Error & { code?: string; cause?: unknown };
      if (coded.code === "42P01") return true;
      if (coded.cause) queue.push(coded.cause);
      continue;
    }
    if (typeof current === "object") {
      const shaped = current as { code?: unknown; message?: unknown; cause?: unknown };
      if (shaped.code === "42P01") return true;
      if (
        typeof shaped.message === "string" &&
        shaped.message.includes('relation "') &&
        shaped.message.includes('" does not exist')
      ) {
        return true;
      }
      if (shaped.cause) queue.push(shaped.cause);
    }
  }
  return false;
}

function queueSchemaNotReadyResponse(c: Context) {
  return c.json(
    {
      code: "QUEUE_SCHEMA_NOT_READY",
      error: "Queue schema is not ready. Run `bun run db:migrate` and restart the API.",
    },
    503,
  );
}

async function withQueueSchemaGuard(
  c: Context,
  handler: () => Promise<Response>,
): Promise<Response> {
  try {
    return await handler();
  } catch (error) {
    if (isMissingRelationError(error)) {
      return queueSchemaNotReadyResponse(c);
    }
    throw error;
  }
}

queueRouter.get("/", zValidator("query", listQuerySchema), async (c) =>
  withQueueSchemaGuard(c, async () => {
    const params = c.req.valid("query");
    const result = await listQueueItems(params);
    return c.json(result);
  }),
);

queueRouter.get("/stats", async (c) =>
  withQueueSchemaGuard(c, async () => {
    const result = await fetchQueueDashboardStats();
    return c.json(result);
  }),
);

queueRouter.get("/active", async (c) =>
  withQueueSchemaGuard(c, async () => {
    const result = await fetchActiveTasks();
    return c.json(result);
  }),
);

queueRouter.post(
  "/:queue/pause",
  zValidator("param", z.object({ queue: z.enum(queueNameValues) })),
  zValidator("json", laneControlBodySchema),
  async (c) =>
    withQueueSchemaGuard(c, async () => {
      const { queue } = c.req.valid("param");
      const { reason } = c.req.valid("json");
      const result = await pauseQueueLane(queue, reason);
      return c.json({ ok: true, ...result });
    }),
);

queueRouter.post(
  "/:queue/resume",
  zValidator("param", z.object({ queue: z.enum(queueNameValues) })),
  zValidator("json", laneControlBodySchema),
  async (c) =>
    withQueueSchemaGuard(c, async () => {
      const { queue } = c.req.valid("param");
      const { reason } = c.req.valid("json");
      const result = await resumeQueueLane(queue, reason);
      return c.json({ ok: true, ...result });
    }),
);

queueRouter.post(
  "/:queue/:id/pause",
  zValidator("param", queueIdParamSchema),
  zValidator("json", pauseBodySchema),
  async (c) =>
    withQueueSchemaGuard(c, async () => {
      const { queue, id } = c.req.valid("param");
      const { reason } = c.req.valid("json");
      const result = await pauseTarget(queue, id, reason);
      if (!result) {
        return c.json({ error: "Queue job not found or unable to pause" }, 404);
      }
      return c.json({ ok: true, item: result });
    }),
);

queueRouter.post("/:queue/:id/resume", zValidator("param", queueIdParamSchema), async (c) =>
  withQueueSchemaGuard(c, async () => {
    const { queue, id } = c.req.valid("param");
    const result = await resumeTarget(queue, id);
    if (!result) {
      return c.json({ error: "Queue job not found or unable to resume" }, 404);
    }
    return c.json({ ok: true, item: result });
  }),
);

queueRouter.post(
  "/:queue/:id/retry",
  zValidator("param", queueIdParamSchema),
  zValidator("json", retryBodySchema),
  async (c) =>
    withQueueSchemaGuard(c, async () => {
      const { queue, id } = c.req.valid("param");
      const { mode, forceRefreshEvidence, reason } = c.req.valid("json");
      const result = await retryTarget({
        queueName: queue as DistillationQueueName,
        id,
        mode,
        forceRefreshEvidence,
        reason,
      });
      if (!result) {
        return c.json({ error: "Queue job not found or unable to retry" }, 404);
      }
      return c.json({ ok: true, item: result });
    }),
);
