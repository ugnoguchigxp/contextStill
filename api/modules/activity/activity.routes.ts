import { Hono } from "hono";
import { db } from "../../../src/db/client.js";
import { vibeMemories } from "../../../src/db/schema.js";
import { desc, eq } from "drizzle-orm";

export const activityRouter = new Hono();

activityRouter.get("/", async (c) => {
  const limit = Number(c.req.query("limit") ?? 100);
  const memories = await db
    .select()
    .from(vibeMemories)
    .orderBy(desc(vibeMemories.createdAt))
    .limit(limit);
  return c.json({ memories });
});

activityRouter.delete("/:id", async (c) => {
  const id = c.req.param("id");
  await db.delete(vibeMemories).where(eq(vibeMemories.id, id));
  return c.json({ ok: true });
});
