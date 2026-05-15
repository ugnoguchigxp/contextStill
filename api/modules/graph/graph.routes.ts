import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { buildGraphSnapshot } from "./graph.repository.js";

const graphQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(300).default(80),
  status: z.enum(["current", "active", "draft", "deprecated", "all"]).default("current"),
  edgeMode: z.enum(["semantic", "relations", "both"]).default("both"),
  minSimilarity: z.coerce.number().min(0).max(1).default(0.72),
  semanticTopK: z.coerce.number().int().min(1).max(10).default(3),
});

export const graphRouter = new Hono().get("/", zValidator("query", graphQuerySchema), async (c) => {
  const query = c.req.valid("query");
  const graph = await buildGraphSnapshot(query);
  return c.json(graph);
});
