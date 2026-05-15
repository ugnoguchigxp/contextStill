import { zValidator } from "@hono/zod-validator";
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../../src/db/client.js";
import { vibeMemories } from "../../../src/db/schema.js";
import { recordVibeMemoryWithDiffEntries } from "../../../src/modules/vibe-memory/vibe-memory.service.js";
import { recordVibeMemoryInputSchema } from "../../../src/shared/schemas/vibe-memory.schema.js";

export const vibeMemoryRouter = new Hono();

vibeMemoryRouter.get("/", async (c) => {
  const limit = Number(c.req.query("limit") ?? 100);
  const memories = await db
    .select()
    .from(vibeMemories)
    .orderBy(desc(vibeMemories.createdAt))
    .limit(limit);
  return c.json({ memories });
});

vibeMemoryRouter.get("/:id", async (c) => {
  const id = c.req.param("id");
  const [memory] = await db.select().from(vibeMemories).where(eq(vibeMemories.id, id));
  if (!memory) {
    return c.json({ error: "Vibe memory not found" }, 404);
  }
  return c.json({ memory });
});

vibeMemoryRouter.post("/", zValidator("json", recordVibeMemoryInputSchema), async (c) => {
  const result = await recordVibeMemoryWithDiffEntries(c.req.valid("json"));
  return c.json(result, 201);
});

vibeMemoryRouter.delete("/:id", async (c) => {
  const id = c.req.param("id");
  await db.delete(vibeMemories).where(eq(vibeMemories.id, id));
  return c.json({ ok: true });
});
