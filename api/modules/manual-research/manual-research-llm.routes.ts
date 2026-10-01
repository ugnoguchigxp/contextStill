import { Hono } from "hono";
import { z } from "zod";
import { groupedConfig } from "../../../src/config.js";
import { createLocalLlmProvider } from "../../../src/modules/llm/providers/local-llm.provider.js";
import {
  ensureRuntimeSettingsLoaded,
  getRuntimeSettingsSnapshot,
} from "../../../src/modules/settings/settings.service.js";
import { isLarmAgentConnectionRoute } from "../../../src/modules/settings/settings.types.js";

const requestSchema = z.object({
  model: z.literal("deepstill-manual"),
  messages: z.tuple([
    z.object({ role: z.literal("system"), content: z.string().min(1).max(250_000) }),
    z.object({ role: z.literal("user"), content: z.string().min(1).max(500_000) }),
  ]),
  temperature: z.literal(0),
  max_tokens: z.number().int().min(1).max(30_000),
  stream: z.literal(false),
});

function selectedLocalModel() {
  const settings = getRuntimeSettingsSnapshot();
  const route = settings.taskRouting.deepStillManual;
  if (
    !settings.providers["local-llm"].enabled ||
    isLarmAgentConnectionRoute(route) ||
    route.provider !== "local-llm" ||
    route.providerPoolId ||
    route.fallback.length > 0
  ) {
    return null;
  }
  const raw = route.model?.trim();
  if (!raw) return null;
  let target: { apiBaseUrl: string; apiPath: string; model: string } | null = null;
  try {
    target = z
      .object({ apiBaseUrl: z.string(), apiPath: z.string(), model: z.string() })
      .parse(JSON.parse(raw));
  } catch {
    // Legacy routes store only the model name.
  }
  return (
    groupedConfig.localLlm.models.find((item) =>
      target
        ? item.apiBaseUrl.replace(/\/+$/, "") === target.apiBaseUrl.replace(/\/+$/, "") &&
          item.apiPath === target.apiPath &&
          item.model === target.model
        : item.model === raw,
    ) ?? null
  );
}

export const manualResearchLlmRouter = new Hono().post("/chat/completions", async (c) => {
  const parsed = requestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid_input" }, 400);
  await ensureRuntimeSettingsLoaded();
  const model = selectedLocalModel();
  if (!model) return c.json({ error: "local_llm_route_unavailable" }, 503);
  try {
    const result = await createLocalLlmProvider({
      timeoutMs: 120_000,
      modelConfig: model,
    }).chat({
      messages: parsed.data.messages,
      maxTokens: parsed.data.max_tokens,
      temperature: 0,
    });
    const promptTokens = result.usage?.promptTokens ?? 0;
    const completionTokens = result.usage?.completionTokens ?? 0;
    return c.json({
      choices: [{ message: { content: result.content }, finish_reason: result.finishReason }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: result.usage?.totalTokens ?? promptTokens + completionTokens,
      },
    });
  } catch {
    return c.json({ error: "local_llm_request_failed" }, 502);
  }
});
