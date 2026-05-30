import { zValidator } from "@hono/zod-validator";
import { desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../../src/db/client.js";
import { vibeMemories } from "../../../src/db/schema.js";
import {
  listVibeGoals,
  markVibeMemory,
  recordVibeMemoryCapsule,
  recordVibeMemoryWithDiffEntries,
  retrieveVibeMemoryContext,
} from "../../../src/modules/vibe-memory/vibe-memory.service.js";

import {
  markVibeMemoryInputSchema,
  recordVibeMemoryCapsuleInputSchema,
  recordVibeMemoryInputSchema,
} from "../../../src/shared/schemas/vibe-memory.schema.js";

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
    .orderBy(desc(effectiveTimestamp), desc(vibeMemories.createdAt))
    .limit(limit);
  return c.json({ memories });
});

/**
 * Goal Room Memory: Retrieve Context / Brief
 * GET /api/vibe-memory/context
 */
vibeMemoryRouter.get("/context", async (c) => {
  const query = c.req.query("query");
  const sessionId = c.req.query("sessionId");
  const goalId = c.req.query("goalId");
  const limit = c.req.query("limit") ? Number(c.req.query("limit")) : undefined;

  // profile can be passed as multiple query parameters: ?profile=code-review&profile=implementation
  const profile = c.req.queries("profile") ?? [];

  const result = await retrieveVibeMemoryContext({
    query,
    sessionId,
    goalId,
    profile,
    limit,
  });

  return c.json(result);
});

/**
 * Goal Room Memory: List Goals
 * GET /api/vibe-memory/goals
 */
vibeMemoryRouter.get("/goals", async (c) => {
  const goals = await listVibeGoals();
  return c.json({ goals });
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

/**
 * Goal Room Memory: Record Capsule
 * POST /api/vibe-memory/record
 */
vibeMemoryRouter.post(
  "/record",
  zValidator("json", recordVibeMemoryCapsuleInputSchema),
  async (c) => {
    const result = await recordVibeMemoryCapsule(c.req.valid("json"));
    return c.json(result, 201);
  },
);

/**
 * Goal Room Memory: Add Mark (付箋)
 * POST /api/vibe-memory/mark
 */
vibeMemoryRouter.post("/mark", zValidator("json", markVibeMemoryInputSchema), async (c) => {
  const result = await markVibeMemory(c.req.valid("json"));
  return c.json(result, 201);
});
