import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import {
  createCodeSymbol,
  deleteCodeSymbol,
  listCodeSymbols,
  updateCodeSymbol,
} from "./code-index.repository.js";

const listCodeSymbolsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(300).default(100),
});

const codeSymbolWriteSchema = z.object({
  repoPath: z.string().trim().min(1),
  filePath: z.string().trim().min(1),
  symbolName: z.string().trim().min(1),
  symbolKind: z.string().trim().min(1),
  signature: z.string().trim().nullable().optional(),
  startLine: z.number().int().positive().nullable().optional(),
  endLine: z.number().int().positive().nullable().optional(),
  active: z.boolean().default(true),
  metadata: z.record(z.unknown()).default({}),
});

export const codeIndexRouter = new Hono()
  .get("/symbols", zValidator("query", listCodeSymbolsQuerySchema), async (c) => {
    const query = c.req.valid("query");
    const symbols = await listCodeSymbols(query.limit);
    return c.json({ symbols });
  })
  .post("/symbols", zValidator("json", codeSymbolWriteSchema), async (c) => {
    const symbol = await createCodeSymbol(c.req.valid("json"));
    return c.json({ symbol }, 201);
  })
  .put("/symbols/:id", zValidator("json", codeSymbolWriteSchema), async (c) => {
    const symbol = await updateCodeSymbol(c.req.param("id"), c.req.valid("json"));
    if (!symbol) return c.json({ error: "not found" }, 404);
    return c.json({ symbol });
  })
  .delete("/symbols/:id", async (c) => {
    const symbol = await deleteCodeSymbol(c.req.param("id"));
    if (!symbol) return c.json({ error: "not found" }, 404);
    return c.json({ symbol });
  });
