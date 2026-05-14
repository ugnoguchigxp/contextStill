import { Hono } from "hono";
import { db } from "../../../src/db/client.js";
import { aiArtifacts, artifactSymbols } from "../../../src/db/schema.js";
import { desc } from "drizzle-orm";

export const artifactsRouter = new Hono();

artifactsRouter.get("/", async (c) => {
  const limit = Number(c.req.query("limit") ?? 100);
  const artifacts = await db
    .select()
    .from(aiArtifacts)
    .orderBy(desc(aiArtifacts.createdAt))
    .limit(limit);
  return c.json({ artifacts });
});

artifactsRouter.get("/symbols", async (c) => {
  const limit = Number(c.req.query("limit") ?? 120);
  const symbols = await db
    .select()
    .from(artifactSymbols)
    .orderBy(desc(artifactSymbols.updatedAt))
    .limit(limit);
  return c.json({ symbols });
});
