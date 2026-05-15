import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { listAuditLogsForApi } from "./audit.repository.js";

const listAuditLogsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  eventType: z.string().trim().min(1).optional(),
  actor: z.enum(["agent", "user", "system"]).optional(),
});

export const auditLogsRouter = new Hono().get(
  "/",
  zValidator("query", listAuditLogsQuerySchema),
  async (c) => {
    const query = c.req.valid("query");
    const result = await listAuditLogsForApi(query);
    const totalPages = result.total === 0 ? 0 : Math.ceil(result.total / result.limit);
    return c.json({
      items: result.items,
      availableEventTypes: result.availableEventTypes,
      pagination: {
        page: result.page,
        limit: result.limit,
        total: result.total,
        totalPages,
        hasNextPage: result.page * result.limit < result.total,
      },
    });
  },
);
