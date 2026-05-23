import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import {
  type GraphRelationAxis,
  type GraphSnapshotParams,
  buildGraphSnapshot,
  fetchGraphNodeDetail,
  listGraphCommunityLabels,
  upsertGraphCommunityLabel,
} from "./graph.repository.js";

const graphQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(1000),
  status: z.enum(["current", "active", "draft", "deprecated", "all"]).default("current"),
  view: z.enum(["relation", "semantic", "community", "evidence"]).default("relation"),
  relationAxes: z.string().default("session,project,source"),
  communityDisplay: z.enum(["detail", "supernode"]).default("detail"),
  minSimilarity: z.coerce.number().min(0).max(1).default(0.72),
  semanticTopK: z.coerce.number().int().min(1).max(10).default(3),
  maxContextEdgesPerNode: z.coerce.number().int().min(1).max(10).default(3),
  sourceNodeLimit: z.coerce.number().int().min(1).max(2000).default(800),
});

const communityLabelsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(1000),
  status: z.enum(["current", "active", "draft", "deprecated", "all"]).default("current"),
  relationAxes: z.string().default("session,project,source"),
});

const communityLabelParamSchema = z.object({
  communityKey: z.string().regex(/^[a-fA-F0-9]{64}$/),
});

const communityLabelBodySchema = z.object({
  label: z.string().trim().min(1).max(120),
  note: z.string().trim().max(500).optional().or(z.literal("")),
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
  .get("/community-labels", zValidator("query", communityLabelsQuerySchema), async (c) => {
    const query = c.req.valid("query");
    const labels = await listGraphCommunityLabels({
      limit: query.limit,
      status: query.status,
      relationAxes: parseRelationAxes(query.relationAxes),
    });
    return c.json({ labels });
  })
  .put(
    "/community-labels/:communityKey",
    zValidator("param", communityLabelParamSchema),
    zValidator("json", communityLabelBodySchema),
    async (c) => {
      const { communityKey } = c.req.valid("param");
      const input = c.req.valid("json");
      const label = await upsertGraphCommunityLabel({
        communityKey,
        label: input.label,
        note: input.note,
      });
      return c.json({
        label: {
          communityKey: label.communityKey,
          label: label.label,
          note: label.note,
          updatedAt: label.updatedAt.toISOString(),
        },
      });
    },
  )
  .get("/nodes/:id", async (c) => {
    const id = c.req.param("id");
    const detail = await fetchGraphNodeDetail(id);
    if (!detail) {
      return c.json({ error: "Node not found" }, 404);
    }
    return c.json(detail);
  });
