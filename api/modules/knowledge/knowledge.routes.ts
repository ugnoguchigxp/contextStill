import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import {
  createKnowledgeItem,
  deleteKnowledgeItem,
  listKnowledgeItems,
  updateKnowledgeItem,
} from "./knowledge.repository.js";
import { knowledgeStatusValues, knowledgeTypeValues, scopeValues } from "../../../src/db/schema.js";

const listKnowledgeQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  status: z.string().trim().min(1).optional(),
  type: z.string().trim().min(1).optional(),
  query: z.string().trim().optional(),
});

const knowledgeWriteSchema = z.object({
  type: z.enum(knowledgeTypeValues),
  status: z.enum(knowledgeStatusValues),
  scope: z.enum(scopeValues),
  title: z.string().trim().min(1),
  body: z.string().trim().min(1),
  confidence: z.number().min(0).max(1).default(0.7),
  importance: z.number().min(0).max(1).default(0.7),
  metadata: z.record(z.unknown()).default({}),
});

export const knowledgeRouter = new Hono()
  .get("/", zValidator("query", listKnowledgeQuerySchema), async (c) => {
    const query = c.req.valid("query");
    const items = await listKnowledgeItems(query);
    return c.json({ items });
  })
  .post("/", zValidator("json", knowledgeWriteSchema), async (c) => {
    const input = c.req.valid("json");
    const item = await createKnowledgeItem(input);
    return c.json({ item }, 201);
  })
  .put("/:id", zValidator("json", knowledgeWriteSchema), async (c) => {
    const item = await updateKnowledgeItem(c.req.param("id"), c.req.valid("json"));
    if (!item) return c.json({ error: "not found" }, 404);
    return c.json({ item });
  })
  .delete("/:id", async (c) => {
    const item = await deleteKnowledgeItem(c.req.param("id"));
    if (!item) return c.json({ error: "not found" }, 404);
    return c.json({ item });
  });
