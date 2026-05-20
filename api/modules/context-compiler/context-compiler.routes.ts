import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { compileInputSchema } from "../../../src/shared/schemas/compile.schema.js";
import {
  compilePackForApi,
  getRunDetailForApi,
  getRunDetailParamSchema,
  listRunsForApi,
  listRunsQuerySchema,
} from "./context-compiler.service.js";

export const contextCompilerRouter = new Hono()
  .post("/compile", zValidator("json", compileInputSchema), async (c) => {
    const input = c.req.valid("json");
    const pack = await compilePackForApi(input);
    return c.json({ pack });
  })
  .get("/runs", zValidator("query", listRunsQuerySchema), async (c) => {
    const query = c.req.valid("query");
    const runs = await listRunsForApi(query);
    return c.json({ runs });
  })
  .get("/runs/:id", zValidator("param", getRunDetailParamSchema), async (c) => {
    const params = c.req.valid("param");
    const detail = await getRunDetailForApi(params);
    if (!detail) {
      return c.json({ error: "Compile run not found." }, 404);
    }
    return c.json({ detail });
  });
