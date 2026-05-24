import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { buildLandscapeReplayComparison } from "../../../src/modules/landscape/landscape-replay-comparison.service.js";
import { buildLandscapeReplaySnapshot } from "../../../src/modules/landscape/landscape-replay.service.js";
import { createLandscapeReviewCandidates } from "../../../src/modules/landscape/landscape-review-candidate.service.js";
import {
  LandscapeReviewItemsError,
  listLandscapeReviewItems,
  materializeLandscapeReviewItems,
  updateLandscapeReviewItemStatus,
} from "../../../src/modules/landscape/landscape-review-items.service.js";
import { buildLandscapeSnapshot } from "../../../src/modules/landscape/landscape.service.js";
import {
  landscapeReplayComparisonResponseSchema,
  landscapeReplaySnapshotSchema,
} from "../../../src/shared/schemas/landscape-replay.schema.js";
import {
  landscapeReviewCandidateCreateInputSchema,
  landscapeReviewCandidateCreateResultSchema,
} from "../../../src/shared/schemas/landscape-review-candidate.schema.js";
import {
  landscapeReviewItemStatusUpdateSchema,
  landscapeReviewItemsListQuerySchema,
  landscapeReviewItemsMaterializeInputSchema,
  landscapeReviewItemsMaterializeResultSchema,
} from "../../../src/shared/schemas/landscape-review.schema.js";
import { landscapeSnapshotSchema } from "../../../src/shared/schemas/landscape.schema.js";
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
const landscapeReviewItemParamSchema = z.object({
  id: z.string().trim().min(1),
});

const communityLabelBodySchema = z.object({
  label: z.string().trim().min(1).max(120),
  note: z.string().trim().max(500).optional().or(z.literal("")),
});

const landscapeQuerySchema = z.object({
  windowDays: z.coerce.number().int().min(1).max(180).default(30),
  limit: z.coerce.number().int().min(1).max(1000).default(1000),
  status: z.enum(["current", "active", "draft", "deprecated", "all"]).default("active"),
  relationAxes: z.string().default("session,project,source"),
  minSelectedCount: z.coerce.number().int().min(1).max(100).default(3),
  minFeedbackCount: z.coerce.number().int().min(1).max(100).default(3),
  format: z.enum(["full"]).default("full"),
});

const landscapeReplayQuerySchema = z.object({
  windowDays: z.coerce.number().int().min(1).max(180).default(30),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
  landscapeLimit: z.coerce.number().int().min(1).max(2000).default(1000),
  runStatus: z.enum(["ok", "degraded", "failed", "all"]).default("all"),
  landscapeStatus: z.enum(["current", "active", "draft", "deprecated", "all"]).default("active"),
  relationAxes: z.string().default("session,project,source"),
  minSelectedCount: z.coerce.number().int().min(1).max(100).default(3),
  minFeedbackCount: z.coerce.number().int().min(1).max(100).default(3),
  minSimilarity: z.coerce.number().min(0).max(1).default(0.72),
  semanticTopK: z.coerce.number().int().min(1).max(10).default(3),
  includeRuns: z.preprocess((value) => {
    if (value === "true" || value === true) return true;
    if (value === "false" || value === false) return false;
    return value;
  }, z.boolean().default(true)),
  format: z.enum(["full"]).default("full"),
});

const landscapeReplayComparisonQuerySchema = z.object({
  windowDays: z.coerce.number().int().min(1).max(180).default(30),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  runStatus: z.enum(["ok", "degraded", "failed", "all"]).default("all"),
  currentLimit: z.coerce.number().int().min(1).max(50).default(12),
  includeRuns: z.preprocess((value) => {
    if (value === "true" || value === true) return true;
    if (value === "false" || value === false) return false;
    return value;
  }, z.boolean().default(true)),
  format: z.enum(["full"]).default("full"),
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
  .get("/landscape", zValidator("query", landscapeQuerySchema), async (c) => {
    const query = c.req.valid("query");
    const snapshot = await buildLandscapeSnapshot({
      windowDays: query.windowDays,
      limit: query.limit,
      status: query.status,
      relationAxes: parseRelationAxes(query.relationAxes),
      minSelectedCount: query.minSelectedCount,
      minFeedbackCount: query.minFeedbackCount,
    });
    if (query.format === "full") {
      return c.json(landscapeSnapshotSchema.parse(snapshot));
    }
    return c.json(landscapeSnapshotSchema.parse(snapshot));
  })
  .get("/landscape/replay", zValidator("query", landscapeReplayQuerySchema), async (c) => {
    const query = c.req.valid("query");
    const snapshot = await buildLandscapeReplaySnapshot({
      windowDays: query.windowDays,
      limit: query.limit,
      landscapeLimit: query.landscapeLimit,
      runStatus: query.runStatus,
      landscapeStatus: query.landscapeStatus,
      relationAxes: parseRelationAxes(query.relationAxes),
      minSelectedCount: query.minSelectedCount,
      minFeedbackCount: query.minFeedbackCount,
      minSimilarity: query.minSimilarity,
      semanticTopK: query.semanticTopK,
      includeRuns: query.includeRuns,
    });
    if (query.format === "full") {
      return c.json(landscapeReplaySnapshotSchema.parse(snapshot));
    }
    return c.json(landscapeReplaySnapshotSchema.parse(snapshot));
  })
  .get(
    "/landscape/replay/compare",
    zValidator("query", landscapeReplayComparisonQuerySchema),
    async (c) => {
      const query = c.req.valid("query");
      const comparison = await buildLandscapeReplayComparison({
        windowDays: query.windowDays,
        limit: query.limit,
        runStatus: query.runStatus,
        currentLimit: query.currentLimit,
        includeRuns: query.includeRuns,
      });
      if (query.format === "full") {
        return c.json(landscapeReplayComparisonResponseSchema.parse(comparison));
      }
      return c.json(landscapeReplayComparisonResponseSchema.parse(comparison));
    },
  )
  .post(
    "/landscape/replay/queue",
    zValidator("json", landscapeReviewItemsMaterializeInputSchema),
    async (c) => {
      const input = c.req.valid("json");
      try {
        const result = await materializeLandscapeReviewItems(input);
        return c.json({
          result: landscapeReviewItemsMaterializeResultSchema.parse(result),
        });
      } catch (error) {
        if (error instanceof LandscapeReviewItemsError) {
          return c.json({ error: error.message }, error.statusCode);
        }
        throw error;
      }
    },
  )
  .post(
    "/landscape/review-items/candidates",
    zValidator("json", landscapeReviewCandidateCreateInputSchema),
    async (c) => {
      const input = c.req.valid("json");
      const result = await createLandscapeReviewCandidates(input);
      return c.json({
        result: landscapeReviewCandidateCreateResultSchema.parse(result),
      });
    },
  )
  .get(
    "/landscape/review-items",
    zValidator("query", landscapeReviewItemsListQuerySchema),
    async (c) => {
      const query = c.req.valid("query");
      const result = await listLandscapeReviewItems({
        status: query.status,
        source: query.source,
        reason: query.reason,
        proposedAction: query.proposedAction,
        knowledgeId: query.knowledgeId,
        runId: query.runId,
        communityKey: query.communityKey,
        priorityMin: query.priorityMin,
        limit: query.limit,
      });
      return c.json(result);
    },
  )
  .patch(
    "/landscape/review-items/:id",
    zValidator("param", landscapeReviewItemParamSchema),
    zValidator("json", landscapeReviewItemStatusUpdateSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      try {
        const item = await updateLandscapeReviewItemStatus({
          id,
          status: input.status,
          note: input.note,
        });
        if (!item) return c.json({ error: "not found" }, 404);
        return c.json({ item });
      } catch (error) {
        if (error instanceof LandscapeReviewItemsError) {
          return c.json({ error: error.message }, error.statusCode);
        }
        throw error;
      }
    },
  )
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
