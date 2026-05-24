import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { settingsUpdateRequestSchema } from "../../../src/modules/settings/settings.types.js";
import {
  getSettingsForApi,
  reloadRuntimeCacheForApi,
  testProviderForApi,
  updateSettingsForApi,
} from "./settings.service.js";

const providerParamSchema = z.object({
  provider: z.enum(["openai", "azure-openai", "bedrock", "local-llm"] as const),
});

export const settingsRouter = new Hono()
  .get("/", async (c) => {
    const result = await getSettingsForApi();
    return c.json(result);
  })
  .put("/", zValidator("json", settingsUpdateRequestSchema), async (c) => {
    const result = await updateSettingsForApi(c.req.valid("json"));
    return c.json(result);
  })
  .post("/providers/:provider/test", zValidator("param", providerParamSchema), async (c) => {
    const { provider } = c.req.valid("param");
    const health = await testProviderForApi(provider);
    return c.json({ provider, health });
  })
  .post("/reload-runtime-cache", async (c) => {
    const result = await reloadRuntimeCacheForApi();
    return c.json(result);
  });
