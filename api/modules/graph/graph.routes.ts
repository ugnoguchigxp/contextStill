import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import {
  buildGraphSnapshot,
  fetchGraphNodeDetail,
  type GraphRelationAxis,
  type GraphSnapshotParams,
} from "./graph.repository.js";

const graphQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(1000),
  status: z.enum(["current", "active", "draft", "deprecated", "all"]).default("current"),
  view: z.enum(["relation", "semantic"]).default("relation"),
  relationAxes: z.string().default("session,project,source"),
  minSimilarity: z.coerce.number().min(0).max(1).default(0.72),
  semanticTopK: z.coerce.number().int().min(1).max(10).default(3),
  maxContextEdgesPerNode: z.coerce.number().int().min(1).max(10).default(3),
});

function parseRelationAxes(input: string): GraphRelationAxis[] {
  const deduped = new Set<GraphRelationAxis>();
  for (const token of input.split(",")) {
    const normalized = token.trim().toLowerCase();
    if (normalized === "session") deduped.add("session");
    if (normalized === "project") deduped.add("project");
    if (normalized === "source") deduped.add("source");
  }
  return deduped.size > 0 ? [...deduped] : ["session", "project", "source"];
}

export const graphRouter = new Hono()
  .get("/", zValidator("query", graphQuerySchema), async (c) => {
    const query = c.req.valid("query");
    const params: GraphSnapshotParams = {
      ...query,
      relationAxes: parseRelationAxes(query.relationAxes),
    };
    const graph = await buildGraphSnapshot(params);
    return c.json(graph);
  })
  .get("/nodes/:id", async (c) => {
    const id = c.req.param("id");
    const detail = await fetchGraphNodeDetail(id);
    if (!detail) {
      return c.json({ error: "Node not found" }, 404);
    }
    return c.json(detail);
  });
