import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { buildGraphSnapshot } from "./graph.repository.js";

const graphQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(300).default(80),
});

export const graphRouter = new Hono().get("/", zValidator("query", graphQuerySchema), async (c) => {
  const query = c.req.valid("query");
  const graph = await buildGraphSnapshot(query.limit);
  return c.json(graph);
});
