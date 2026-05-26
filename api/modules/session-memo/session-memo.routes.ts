import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import {
  getSessionMemo,
  listSessionMemoEvents,
  listSessionMemoSessions,
  listSessionMemos,
  putSessionMemo,
} from "../../../src/modules/session-memo/session-memo.service.js";
import { sessionMemoSlotLimit } from "../../../src/shared/schemas/session-memo.schema.js";

export const sessionMemoRouter = new Hono();
const sessionMemoMaxSlot = sessionMemoSlotLimit - 1;

const sessionIdSchema = z.object({ sessionId: z.string().trim().min(1) });
const sessionMemoSessionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  includeCompileOnly: z
    .union([z.literal("true"), z.literal("false")])
    .optional()
    .transform((value) => value === "true"),
});
const sessionMemoLocatorQuerySchema = sessionIdSchema
  .extend({
    slot: z.coerce.number().int().min(0).max(sessionMemoMaxSlot).optional(),
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
  "/sessions",
  zValidator("query", sessionMemoSessionsQuerySchema),
  async (c) => {
    const { limit, includeCompileOnly } = c.req.valid("query");
    const items = await listSessionMemoSessions(limit, includeCompileOnly);
    return c.json({ items });
  },
);

sessionMemoRouter.get("/item", zValidator("query", sessionMemoLocatorQuerySchema), async (c) => {
  const memo = await getSessionMemo(c.req.valid("query"));
  if (!memo) return c.json({ error: "session memo not found" }, 404);
  return c.json({ memo });
});

sessionMemoRouter.post(
  "/item",
  zValidator(
    "json",
    z.object({
      sessionId: z.string().trim().min(1),
      kind: z.string().trim().min(1).max(64).optional(),
      title: z.string().trim().min(1).max(160).optional(),
      score: z.number().int().min(0).max(100).optional(),
      label: z.string().trim().min(1).optional(),
      body: z.string().trim().min(1).max(10000),
      metadata: z.record(z.unknown()).optional(),
      expiresAt: z.string().datetime().optional(),
    }),
  ),
  async (c) => {
    const saved = await putSessionMemo({ ...c.req.valid("json"), source: "ui" });
    return c.json({ memo: saved }, 201);
  },
);
