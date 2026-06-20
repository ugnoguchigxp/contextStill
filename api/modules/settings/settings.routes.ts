import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { settingsUpdateRequestSchema } from "../../../src/modules/settings/settings.types.js";
import {
  getCodexAuthStatusForApi,
  getCodexLoginCommandForApi,
  getSettingsForApi,
  reloadRuntimeCacheForApi,
  testAzureOpenAiDeploymentForApi,
  testLocalLlmModelForApi,
  testProviderForApi,
  updateSettingsForApi,
} from "./settings.service.js";

const providerParamSchema = z.object({
  provider: z.enum(["openai", "azure-openai", "bedrock", "local-llm", "codex"] as const),
});
const azureOpenAiDeploymentParamSchema = z.object({
  deployment: z.coerce.number().int().min(1),
});
const localLlmModelTestBodySchema = z.object({
  model: z.string().trim().min(1),
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
  .post(
    "/providers/azure-openai/deployments/:deployment/test",
    zValidator("param", azureOpenAiDeploymentParamSchema),
    async (c) => {
      const { deployment } = c.req.valid("param");
      const health = await testAzureOpenAiDeploymentForApi(deployment);
      return c.json({ provider: "azure-openai", deployment, health });
    },
  )
  .post(
    "/providers/local-llm/models/test",
    zValidator("json", localLlmModelTestBodySchema),
    async (c) => {
      const body = c.req.valid("json");
      const health = await testLocalLlmModelForApi(body);
      return c.json({ provider: "local-llm", model: body.model, health });
    },
  )
  .post("/providers/:provider/test", zValidator("param", providerParamSchema), async (c) => {
    const { provider } = c.req.valid("param");
    const health = await testProviderForApi(provider);
    return c.json({ provider, health });
  })
  .get("/providers/codex/auth/status", async (c) => {
    const status = await getCodexAuthStatusForApi();
    return c.json(status);
  })
  .post("/providers/codex/auth/login-command", async (c) => {
    const command = getCodexLoginCommandForApi();
    return c.json(command);
  })
  .post("/reload-runtime-cache", async (c) => {
    const result = await reloadRuntimeCacheForApi();
    return c.json(result);
  });
