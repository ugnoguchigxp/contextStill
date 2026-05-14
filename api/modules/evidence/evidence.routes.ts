import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { sourceKindValues } from "../../../src/db/schema.js";
import {
  createEvidenceFragment,
  createEvidenceSource,
  deleteEvidenceFragment,
  deleteEvidenceSource,
  listEvidenceFragments,
  listEvidenceSources,
  updateEvidenceFragment,
  updateEvidenceSource,
} from "./evidence.repository.js";

const listEvidenceQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const metadataSchema = z.record(z.unknown()).default({});

const evidenceSourceWriteSchema = z.object({
  sourceKind: z.enum(sourceKindValues),
  uri: z.string().trim().min(1),
  title: z.string().trim().nullable().optional(),
  contentHash: z.string().trim().optional(),
  metadata: metadataSchema,
});

const evidenceFragmentWriteSchema = z.object({
  sourceId: z.string().uuid(),
  locator: z.string().trim().min(1),
  content: z.string().trim().min(1),
  metadata: metadataSchema,
});

export const evidenceRouter = new Hono()
  .get("/sources", zValidator("query", listEvidenceQuerySchema), async (c) => {
    const query = c.req.valid("query");
    const sources = await listEvidenceSources(query.limit);
    return c.json({ sources });
  })
  .post("/sources", zValidator("json", evidenceSourceWriteSchema), async (c) => {
    const source = await createEvidenceSource(c.req.valid("json"));
    return c.json({ source }, 201);
  })
  .put("/sources/:id", zValidator("json", evidenceSourceWriteSchema), async (c) => {
    const source = await updateEvidenceSource(c.req.param("id"), c.req.valid("json"));
    if (!source) return c.json({ error: "not found" }, 404);
    return c.json({ source });
  })
  .delete("/sources/:id", async (c) => {
    const source = await deleteEvidenceSource(c.req.param("id"));
    if (!source) return c.json({ error: "not found" }, 404);
    return c.json({ source });
  })
  .get("/fragments", zValidator("query", listEvidenceQuerySchema), async (c) => {
    const query = c.req.valid("query");
    const fragments = await listEvidenceFragments(query.limit);
    return c.json({ fragments });
  })
  .post("/fragments", zValidator("json", evidenceFragmentWriteSchema), async (c) => {
    const fragment = await createEvidenceFragment(c.req.valid("json"));
    return c.json({ fragment }, 201);
  })
  .put("/fragments/:id", zValidator("json", evidenceFragmentWriteSchema), async (c) => {
    const fragment = await updateEvidenceFragment(c.req.param("id"), c.req.valid("json"));
    if (!fragment) return c.json({ error: "not found" }, 404);
    return c.json({ fragment });
  })
  .delete("/fragments/:id", async (c) => {
    const fragment = await deleteEvidenceFragment(c.req.param("id"));
    if (!fragment) return c.json({ error: "not found" }, 404);
    return c.json({ fragment });
  });
