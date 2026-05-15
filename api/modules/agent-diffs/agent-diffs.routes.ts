import { and, desc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../../src/db/client.js";
import { agentDiffEntries } from "../../../src/db/schema.js";

export const agentDiffsRouter = new Hono();

agentDiffsRouter.get("/", async (c) => {
  const limit = Number(c.req.query("limit") ?? 120);
  const id = c.req.query("id");
  const vibeMemoryId = c.req.query("vibeMemoryId");
  const vibeMemoryIds = c.req
    .query("vibeMemoryIds")
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const filters = [
    id ? eq(agentDiffEntries.id, id) : undefined,
    vibeMemoryId ? eq(agentDiffEntries.vibeMemoryId, vibeMemoryId) : undefined,
    vibeMemoryIds?.length ? inArray(agentDiffEntries.vibeMemoryId, vibeMemoryIds) : undefined,
  ].filter((filter) => filter !== undefined);
  const entries = await db
    .select()
    .from(agentDiffEntries)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(agentDiffEntries.updatedAt))
    .limit(limit);
  return c.json({ entries });
});
