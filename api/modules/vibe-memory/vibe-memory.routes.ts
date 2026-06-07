import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../../src/db/client.js";
import { vibeMemories } from "../../../src/db/schema.js";
import {
  recordVibeMemoryWithDiffEntries,
  retrieveVibeMemoryContext,
} from "../../../src/modules/vibe-memory/vibe-memory.service.js";

import { recordVibeMemoryInputSchema } from "../../../src/shared/schemas/vibe-memory.schema.js";

export const vibeMemoryRouter = new Hono();

// Legacy compatibility
vibeMemoryRouter.get("/", async (c) => {
  const limit = Number(c.req.query("limit") ?? 100);
  const effectiveTimestamp = sql<string>`coalesce(
    nullif(${vibeMemories.metadata} ->> 'timestamp', ''),
    nullif(${vibeMemories.metadata} ->> 'sessionStartedAt', '')
  )`;
  const memories = await db
    .select()
    .from(vibeMemories)
    .where(and(ne(vibeMemories.memoryType, "capsule")))
    .orderBy(desc(effectiveTimestamp), desc(vibeMemories.createdAt))
    .limit(limit);
  return c.json({ memories });
});

// Legacy contextual search for raw Vibe Memory.
vibeMemoryRouter.get("/context", async (c) => {
  if (c.req.query("goalId") !== undefined || (c.req.queries("profile") ?? []).length > 0) {
    return c.json({ error: "Goal Room context has been removed." }, 400);
  }

  const query = c.req.query("query");
  const sessionId = c.req.query("sessionId");
  const limit = c.req.query("limit") ? Number(c.req.query("limit")) : undefined;

  const result = await retrieveVibeMemoryContext({
    query,
    sessionId,
    limit,
  });

  return c.json(result);
});

// Legacy compatibility
vibeMemoryRouter.get("/:id", async (c) => {
  const id = c.req.param("id");
  const [memory] = await db.select().from(vibeMemories).where(eq(vibeMemories.id, id));
  if (!memory) {
    return c.json({ error: "Vibe memory not found" }, 404);
  }
  return c.json({ memory });
});

// Legacy compatibility
vibeMemoryRouter.post("/", zValidator("json", recordVibeMemoryInputSchema), async (c) => {
  const result = await recordVibeMemoryWithDiffEntries(c.req.valid("json"));
  return c.json(result, 201);
});

// Legacy compatibility
vibeMemoryRouter.delete("/:id", async (c) => {
  const id = c.req.param("id");
  await db.delete(vibeMemories).where(eq(vibeMemories.id, id));
  return c.json({ ok: true });
});
