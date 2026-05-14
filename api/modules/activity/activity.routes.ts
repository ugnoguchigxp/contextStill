import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { db } from "../../../src/db/client.js";
import { vibeMemories } from "../../../src/db/schema.js";
import { desc, eq } from "drizzle-orm";
import { recordActivityWithArtifacts } from "../../../src/modules/activity/activity.service.js";
import { recordActivityInputSchema } from "../../../src/shared/schemas/activity.schema.js";

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

activityRouter.post("/", zValidator("json", recordActivityInputSchema), async (c) => {
  const result = await recordActivityWithArtifacts(c.req.valid("json"));
  return c.json(result, 201);
});

activityRouter.delete("/:id", async (c) => {
  const id = c.req.param("id");
  await db.delete(vibeMemories).where(eq(vibeMemories.id, id));
  return c.json({ ok: true });
});
