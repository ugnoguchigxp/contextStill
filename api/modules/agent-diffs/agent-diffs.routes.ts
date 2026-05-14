import { desc } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../../src/db/client.js";
import { agentDiffEntries } from "../../../src/db/schema.js";

export const agentDiffsRouter = new Hono();

agentDiffsRouter.get("/", async (c) => {
  const limit = Number(c.req.query("limit") ?? 120);
  const entries = await db
    .select()
    .from(agentDiffEntries)
    .orderBy(desc(agentDiffEntries.updatedAt))
    .limit(limit);
  return c.json({ entries });
});
