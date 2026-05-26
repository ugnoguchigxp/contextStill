import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import {
  clearSessionMemos,
  deleteSessionMemo,
  getSessionMemo,
  listSessionMemoEvents,
  listSessionMemos,
  putSessionMemo,
} from "../../../src/modules/session-memo/session-memo.service.js";

export const sessionMemoRouter = new Hono();

const sessionIdSchema = z.object({ sessionId: z.string().trim().min(1) });
const sessionMemoLocatorQuerySchema = sessionIdSchema
  .extend({
    slot: z.coerce.number().int().min(0).max(19).optional(),
    label: z.string().trim().min(1).optional(),
  })
  .refine((value) => value.slot !== undefined || value.label !== undefined, {
    message: "slot or label is required",
    path: ["slot"],
  });

sessionMemoRouter.get("/", zValidator("query", sessionIdSchema), async (c) => {
  const { sessionId } = c.req.valid("query");
  const includeEmpty = c.req.query("includeEmpty") === "true";
  const previewChars = Number(c.req.query("previewChars") ?? 320);
  const items = await listSessionMemos({ sessionId, includeEmpty, previewChars });
  const events = await listSessionMemoEvents(sessionId, 200);
  return c.json({ sessionId, items, events });
});

sessionMemoRouter.get(
  "/item",
  zValidator("query", sessionMemoLocatorQuerySchema),
  async (c) => {
    const memo = await getSessionMemo(c.req.valid("query"));
    if (!memo) return c.json({ error: "session memo not found" }, 404);
    return c.json({ memo });
  },
);

sessionMemoRouter.post(
  "/item",
  zValidator(
    "json",
    z.object({
      sessionId: z.string().trim().min(1),
      slot: z.number().int().min(0).max(19).optional(),
      label: z.string().trim().min(1).optional(),
      body: z.string().trim().min(1).max(4000),
      metadata: z.record(z.unknown()).optional(),
      expiresAt: z.string().datetime().optional(),
    }),
  ),
  async (c) => {
    const saved = await putSessionMemo({ ...c.req.valid("json"), source: "ui" });
    return c.json({ memo: saved }, 201);
  },
);

sessionMemoRouter.delete(
  "/item",
  zValidator("query", sessionMemoLocatorQuerySchema),
  async (c) => {
    const result = await deleteSessionMemo(c.req.valid("query"));
    return c.json(result);
  },
);

sessionMemoRouter.delete("/", zValidator("query", sessionIdSchema), async (c) => {
  const result = await clearSessionMemos(c.req.valid("query").sessionId);
  return c.json(result);
});
