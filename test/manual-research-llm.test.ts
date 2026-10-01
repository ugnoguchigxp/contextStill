import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  route: {
    provider: "local-llm",
    model: JSON.stringify({
      apiBaseUrl: "http://127.0.0.1:8080",
      apiPath: "/v1/chat/completions",
      model: "local-test",
    }),
    fallback: [] as string[],
  },
  calls: [] as unknown[],
}));

vi.mock("../src/modules/settings/settings.service.js", () => ({
  ensureRuntimeSettingsLoaded: async () => {},
  getRuntimeSettingsSnapshot: () => ({
    providers: { "local-llm": { enabled: true } },
    taskRouting: { deepStillManual: fixture.route },
  }),
}));
vi.mock("../src/config.js", () => ({
  groupedConfig: {
    localLlm: {
      models: [
        {
          apiBaseUrl: "http://127.0.0.1:8080",
          apiPath: "/v1/chat/completions",
          model: "local-test",
          apiKey: "model-secret",
        },
      ],
    },
  },
}));
vi.mock("../src/modules/llm/providers/local-llm.provider.js", () => ({
  createLocalLlmProvider: (options: unknown) => ({
    chat: async (request: unknown) => {
      fixture.calls.push({ options, request });
      return {
        content: "local result",
        usage: { promptTokens: 8, completionTokens: 3, totalTokens: 11 },
      };
    },
  }),
}));

import { manualResearchLlmRouter } from "../api/modules/manual-research/manual-research-llm.routes.js";

function app() {
  const app = new Hono();
  app.route("/api/integrations/deepstill/manual/v1", manualResearchLlmRouter);
  return app;
}

const body = {
  model: "deepstill-manual",
  messages: [
    { role: "system", content: "system" },
    { role: "user", content: "research topic" },
  ],
  temperature: 0,
  max_tokens: 1000,
  stream: false,
};

afterEach(() => {
  fixture.route.provider = "local-llm";
  fixture.calls.length = 0;
});

describe("DeepStill manual Local LLM route", () => {
  it("uses the selected local endpoint and returns a compatible completion", async () => {
    const response = await app().request("/api/integrations/deepstill/manual/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      choices: [{ message: { content: "local result" } }],
      usage: { total_tokens: 11 },
    });
    expect(fixture.calls).toMatchObject([
      { options: { modelConfig: { model: "local-test" } }, request: { maxTokens: 1000 } },
    ]);
  });

  it("fails closed when the route does not select Local LLM", async () => {
    fixture.route.provider = "codex";
    const response = await app().request("/api/integrations/deepstill/manual/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(503);
    expect(fixture.calls).toHaveLength(0);
  });
});
