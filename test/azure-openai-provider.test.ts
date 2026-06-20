import { beforeEach, describe, expect, test, vi } from "vitest";
import { groupedConfig } from "../src/config.js";
import {
  callAzureOpenAiChat,
  createAzureOpenAiChatClient,
} from "../src/modules/distillation/providers/azure-openai.js";
import { resetAzureOpenAiDeploymentPoolForTests } from "../src/modules/llm/providers/azure-openai-config.js";
import { createAzureOpenAiProvider } from "../src/modules/llm/providers/azure-openai.provider.js";

vi.mock("../src/config.js", () => ({
  groupedConfig: {
    azureOpenAi: {
      apiKey: "test-api-key",
      apiBaseUrl: "https://test-endpoint.openai.azure.com",
      apiPath: "/openai/deployments",
      model: "gpt-4",
      apiVersion: "2023-05-15",
      deployments: [],
    },
    distillation: {
      timeoutMs: 1000,
    },
  },
}));

describe("azure openai provider", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetAzureOpenAiDeploymentPoolForTests();
    groupedConfig.azureOpenAi.apiKey = "test-api-key";
    groupedConfig.azureOpenAi.apiBaseUrl = "https://test-endpoint.openai.azure.com";
    groupedConfig.azureOpenAi.apiPath = "/openai/deployments";
    groupedConfig.azureOpenAi.model = "gpt-4";
    groupedConfig.azureOpenAi.apiVersion = "2023-05-15";
    groupedConfig.azureOpenAi.deployments = [];
  });

  test("callAzureOpenAiChat sends POST request successfully without tools", async () => {
    const mockResponse = {
      choices: [
        {
          message: {
            content: "Hello from Azure OpenAI",
            role: "assistant",
          },
          finish_reason: "stop",
        },
      ],
    };

    const spy = vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    } as unknown as Response);

    const result = await callAzureOpenAiChat({
      model: "gpt-4",
      messages: [{ role: "user", content: "hello" }],
      maxTokens: 50,
    });

    expect(spy).toHaveBeenCalled();
    expect(result.content).toBe("Hello from Azure OpenAI");
    expect(result.finishReason).toBe("stop");

    const fetchArgs = spy.mock.calls[0];
    expect(fetchArgs[0]).toBe(
      "https://test-endpoint.openai.azure.com/openai/deployments/gpt-4/chat/completions?api-version=2023-05-15",
    );
    const options = fetchArgs[1];
    expect(options?.method).toBe("POST");
    expect((options?.headers as any)["api-key"]).toBe("test-api-key");

    const body = JSON.parse(options?.body as string);
    expect(body.messages).toEqual([{ role: "user", content: "hello" }]);
    expect(body.tool_choice).toBeUndefined();
  });

  test("callAzureOpenAiChat sends POST request successfully with tools", async () => {
    const mockResponse = {
      choices: [
        {
          message: {
            content: "Using tool",
            role: "assistant",
          },
          finish_reason: "stop",
        },
      ],
    };

    const spy = vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    } as unknown as Response);

    const tools = [
      {
        type: "function" as const,
        function: {
          name: "test_tool",
          description: "desc",
          parameters: {
            type: "object" as const,
            properties: {},
            required: [],
            additionalProperties: false as const,
          },
        },
      },
    ];
    const result = await callAzureOpenAiChat({
      model: "gpt-4",
      messages: [{ role: "user", content: "hello" }],
      maxTokens: 50,
      tools,
      toolChoice: "auto",
    });

    expect(result.content).toBe("Using tool");
    const fetchArgs = spy.mock.calls[0];
    const options = fetchArgs[1];
    const body = JSON.parse(options?.body as string);
    expect(body.tools).toEqual(tools);
    expect(body.tool_choice).toBe("auto");
  });

  test("callAzureOpenAiChat throws error on failure response", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => "Bad Request Error details",
    } as unknown as Response);

    await expect(
      callAzureOpenAiChat({
        model: "gpt-4",
        messages: [{ role: "user", content: "hello" }],
        maxTokens: 50,
      }),
    ).rejects.toThrow("Azure OpenAI HTTP 400: Bad Request Error details");
  });

  test("callAzureOpenAiChat retries the next Azure deployment on rate limit", async () => {
    groupedConfig.azureOpenAi.deployments = [
      {
        apiKey: "test-api-key",
        apiBaseUrl: "https://test-endpoint.openai.azure.com",
        apiPath: "/openai/deployments",
        model: "gpt-4",
        apiVersion: "2023-05-15",
      },
      {
        apiKey: "second-key",
        apiBaseUrl: "https://second.openai.azure.com",
        apiPath: "/openai/deployments",
        model: "gpt-4b",
        apiVersion: "2023-05-15",
      },
    ];

    const spy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: new Headers(),
        text: async () => "rate limited",
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "second deployment" }, finish_reason: "stop" }],
        }),
      } as unknown as Response);

    const result = await callAzureOpenAiChat({
      model: "gpt-4",
      messages: [{ role: "user", content: "hello" }],
      maxTokens: 50,
    });

    expect(result.content).toBe("second deployment");
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1]?.[0]).toBe(
      "https://second.openai.azure.com/openai/deployments/gpt-4b/chat/completions?api-version=2023-05-15",
    );
    expect((spy.mock.calls[1]?.[1]?.headers as any)["api-key"]).toBe("second-key");
  });

  test("callAzureOpenAiChat retries the next Azure deployment when a slot is missing", async () => {
    groupedConfig.azureOpenAi.deployments = [
      {
        apiKey: "test-api-key",
        apiBaseUrl: "https://test-endpoint.openai.azure.com",
        apiPath: "/openai/deployments",
        model: "gpt-4",
        apiVersion: "2023-05-15",
      },
      {
        apiKey: "second-key",
        apiBaseUrl: "https://second.openai.azure.com",
        apiPath: "/openai/deployments",
        model: "gpt-4b",
        apiVersion: "2023-05-15",
      },
    ];

    const spy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        headers: new Headers(),
        text: async () =>
          JSON.stringify({
            error: {
              code: "DeploymentNotFound",
              message: "The API deployment for this resource does not exist.",
            },
          }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "second deployment" }, finish_reason: "stop" }],
        }),
      } as unknown as Response);

    const result = await callAzureOpenAiChat({
      model: "gpt-4",
      messages: [{ role: "user", content: "hello" }],
      maxTokens: 50,
    });

    expect(result.content).toBe("second deployment");
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1]?.[0]).toBe(
      "https://second.openai.azure.com/openai/deployments/gpt-4b/chat/completions?api-version=2023-05-15",
    );
  });

  test("callAzureOpenAiChat keeps Azure deployment order across fresh tasks", async () => {
    groupedConfig.azureOpenAi.deployments = [
      {
        apiKey: "test-api-key",
        apiBaseUrl: "https://test-endpoint.openai.azure.com",
        apiPath: "/openai/deployments",
        model: "gpt-4",
        apiVersion: "2023-05-15",
      },
      {
        apiKey: "second-key",
        apiBaseUrl: "https://second.openai.azure.com",
        apiPath: "/openai/deployments",
        model: "gpt-4b",
        apiVersion: "2023-05-15",
      },
    ];

    const spy = vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      }),
    } as unknown as Response);

    await callAzureOpenAiChat({
      model: "gpt-4",
      messages: [{ role: "user", content: "first" }],
      maxTokens: 50,
    });
    await callAzureOpenAiChat({
      model: "gpt-4",
      messages: [{ role: "user", content: "second" }],
      maxTokens: 50,
    });

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0]?.[0]).toBe(
      "https://test-endpoint.openai.azure.com/openai/deployments/gpt-4/chat/completions?api-version=2023-05-15",
    );
    expect(spy.mock.calls[1]?.[0]).toBe(
      "https://test-endpoint.openai.azure.com/openai/deployments/gpt-4/chat/completions?api-version=2023-05-15",
    );
  });

  test("createAzureOpenAiChatClient pins one Azure deployment within the same task", async () => {
    groupedConfig.azureOpenAi.deployments = [
      {
        apiKey: "test-api-key",
        apiBaseUrl: "https://test-endpoint.openai.azure.com",
        apiPath: "/openai/deployments",
        model: "gpt-4",
        apiVersion: "2023-05-15",
      },
      {
        apiKey: "second-key",
        apiBaseUrl: "https://second.openai.azure.com",
        apiPath: "/openai/deployments",
        model: "gpt-4b",
        apiVersion: "2023-05-15",
      },
    ];

    const spy = vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      }),
    } as unknown as Response);

    const client = createAzureOpenAiChatClient();
    await client({
      model: "gpt-4",
      messages: [{ role: "user", content: "first" }],
      maxTokens: 50,
    });
    await client({
      model: "gpt-4",
      messages: [{ role: "user", content: "same task" }],
      maxTokens: 50,
    });

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0]?.[0]).toBe(
      "https://test-endpoint.openai.azure.com/openai/deployments/gpt-4/chat/completions?api-version=2023-05-15",
    );
    expect(spy.mock.calls[1]?.[0]).toBe(
      "https://test-endpoint.openai.azure.com/openai/deployments/gpt-4/chat/completions?api-version=2023-05-15",
    );
  });

  test("createAzureOpenAiChatClient can restrict routing to selected deployment slots", async () => {
    groupedConfig.azureOpenAi.deployments = [
      {
        apiKey: "test-api-key",
        apiBaseUrl: "https://test-endpoint.openai.azure.com",
        apiPath: "/openai/deployments",
        model: "gpt-4",
        apiVersion: "2023-05-15",
      },
      {
        apiKey: "second-key",
        apiBaseUrl: "https://second.openai.azure.com",
        apiPath: "/openai/deployments",
        model: "gpt-4b",
        apiVersion: "2023-05-15",
      },
    ];

    const spy = vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      }),
    } as unknown as Response);

    const client = createAzureOpenAiChatClient([2]);
    await client({
      model: "gpt-4",
      messages: [{ role: "user", content: "first" }],
      maxTokens: 50,
    });
    await client({
      model: "gpt-4",
      messages: [{ role: "user", content: "second" }],
      maxTokens: 50,
    });

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0]?.[0]).toBe(
      "https://second.openai.azure.com/openai/deployments/gpt-4b/chat/completions?api-version=2023-05-15",
    );
    expect(spy.mock.calls[1]?.[0]).toBe(
      "https://second.openai.azure.com/openai/deployments/gpt-4b/chat/completions?api-version=2023-05-15",
    );
  });

  test("callAzureOpenAiChat skips a rate-limited Azure deployment on the next task", async () => {
    groupedConfig.azureOpenAi.deployments = [
      {
        apiKey: "test-api-key",
        apiBaseUrl: "https://test-endpoint.openai.azure.com",
        apiPath: "/openai/deployments",
        model: "gpt-4",
        apiVersion: "2023-05-15",
      },
      {
        apiKey: "second-key",
        apiBaseUrl: "https://second.openai.azure.com",
        apiPath: "/openai/deployments",
        model: "gpt-4b",
        apiVersion: "2023-05-15",
      },
    ];

    const spy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: new Headers({ "retry-after": "60" }),
        text: async () => "rate limited",
      } as unknown as Response)
      .mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "second deployment" }, finish_reason: "stop" }],
        }),
      } as unknown as Response);

    await callAzureOpenAiChat({
      model: "gpt-4",
      messages: [{ role: "user", content: "first" }],
      maxTokens: 50,
    });
    await callAzureOpenAiChat({
      model: "gpt-4",
      messages: [{ role: "user", content: "second" }],
      maxTokens: 50,
    });

    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy.mock.calls[1]?.[0]).toBe(
      "https://second.openai.azure.com/openai/deployments/gpt-4b/chat/completions?api-version=2023-05-15",
    );
    expect(spy.mock.calls[2]?.[0]).toBe(
      "https://second.openai.azure.com/openai/deployments/gpt-4b/chat/completions?api-version=2023-05-15",
    );
  });

  test("callAzureOpenAiChat keeps the failover deployment while the first endpoint is cooling down", async () => {
    groupedConfig.azureOpenAi.deployments = [
      {
        apiKey: "test-api-key",
        apiBaseUrl: "https://test-endpoint.openai.azure.com",
        apiPath: "/openai/deployments",
        model: "gpt-4",
        apiVersion: "2023-05-15",
      },
      {
        apiKey: "second-key",
        apiBaseUrl: "https://second.openai.azure.com",
        apiPath: "/openai/deployments",
        model: "gpt-4b",
        apiVersion: "2023-05-15",
      },
      {
        apiKey: "third-key",
        apiBaseUrl: "https://third.openai.azure.com",
        apiPath: "/openai/deployments",
        model: "gpt-4c",
        apiVersion: "2023-05-15",
      },
    ];

    const spy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: new Headers({ "retry-after": "60" }),
        text: async () => "rate limited",
      } as unknown as Response)
      .mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        }),
      } as unknown as Response);

    await callAzureOpenAiChat({
      model: "gpt-4",
      messages: [{ role: "user", content: "first" }],
      maxTokens: 50,
    });
    await callAzureOpenAiChat({
      model: "gpt-4",
      messages: [{ role: "user", content: "second" }],
      maxTokens: 50,
    });

    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy.mock.calls[1]?.[0]).toBe(
      "https://second.openai.azure.com/openai/deployments/gpt-4b/chat/completions?api-version=2023-05-15",
    );
    expect(spy.mock.calls[2]?.[0]).toBe(
      "https://second.openai.azure.com/openai/deployments/gpt-4b/chat/completions?api-version=2023-05-15",
    );
  });

  test("agentic Azure provider retries the next deployment when a slot is missing", async () => {
    groupedConfig.azureOpenAi.deployments = [
      {
        apiKey: "test-api-key",
        apiBaseUrl: "https://test-endpoint.openai.azure.com",
        apiPath: "/openai/deployments",
        model: "gpt-4",
        apiVersion: "2023-05-15",
      },
      {
        apiKey: "second-key",
        apiBaseUrl: "https://second.openai.azure.com",
        apiPath: "/openai/deployments",
        model: "gpt-4b",
        apiVersion: "2023-05-15",
      },
    ];

    const spy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        headers: new Headers(),
        text: async () =>
          JSON.stringify({
            error: {
              code: "DeploymentNotFound",
              message: "The API deployment for this resource does not exist.",
            },
          }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "second deployment" }, finish_reason: "stop" }],
        }),
      } as unknown as Response);

    const response = await createAzureOpenAiProvider({ timeoutMs: 1000 }).chat({
      messages: [{ role: "user", content: "hello" }],
      maxTokens: 50,
    });

    expect(response.content).toBe("second deployment");
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1]?.[0]).toBe(
      "https://second.openai.azure.com/openai/deployments/gpt-4b/chat/completions?api-version=2023-05-15",
    );
  });

  test("healthCheck can target a specific Azure deployment slot", async () => {
    groupedConfig.azureOpenAi.deployments = [
      {
        apiKey: "test-api-key",
        apiBaseUrl: "https://test-endpoint.openai.azure.com",
        apiPath: "/openai/deployments",
        model: "gpt-4",
        apiVersion: "2023-05-15",
      },
      {
        apiKey: "second-key",
        apiBaseUrl: "https://second.openai.azure.com",
        apiPath: "/openai/deployments",
        model: "gpt-4b",
        apiVersion: "2023-05-15",
      },
    ];

    const spy = vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "pong" }, finish_reason: "stop" }],
      }),
    } as unknown as Response);

    const status = await createAzureOpenAiProvider({
      deploymentIndex: 1,
      timeoutMs: 1000,
    }).healthCheck();

    expect(status.configured).toBe(true);
    expect(status.reachable).toBe(true);
    expect(status.model).toBe("gpt-4b");
    expect(status.endpoint).toBe("https://second.openai.azure.com");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toBe(
      "https://second.openai.azure.com/openai/deployments/gpt-4b/chat/completions?api-version=2023-05-15",
    );
    expect((spy.mock.calls[0]?.[1]?.headers as any)["api-key"]).toBe("second-key");
    expect(JSON.parse(spy.mock.calls[0]?.[1]?.body as string).max_completion_tokens).toBe(16);
  });

  test("healthCheck checks another configured Azure deployment when one slot is unavailable", async () => {
    groupedConfig.azureOpenAi.deployments = [
      {
        apiKey: "test-api-key",
        apiBaseUrl: "https://test-endpoint.openai.azure.com",
        apiPath: "/openai/deployments",
        model: "gpt-4",
        apiVersion: "2023-05-15",
      },
      {
        apiKey: "second-key",
        apiBaseUrl: "https://second.openai.azure.com",
        apiPath: "/openai/deployments",
        model: "gpt-4b",
        apiVersion: "2023-05-15",
      },
    ];

    const spy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        headers: new Headers(),
        text: async () => "DeploymentNotFound",
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "pong" }, finish_reason: "stop" }],
        }),
      } as unknown as Response);

    const status = await createAzureOpenAiProvider({ timeoutMs: 1000 }).healthCheck();

    expect(status.configured).toBe(true);
    expect(status.reachable).toBe(true);
    expect(status.model).toBe("gpt-4b");
    expect(status.endpoint).toBe("https://second.openai.azure.com");
    expect(status.error).toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  test("healthCheck treats an empty successful Azure response as reachable", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "" }, finish_reason: "length" }],
      }),
    } as unknown as Response);

    const status = await createAzureOpenAiProvider({ timeoutMs: 1000 }).healthCheck();

    expect(status.configured).toBe(true);
    expect(status.reachable).toBe(true);
    expect(status.error).toBeUndefined();
  });

  test("healthCheck treats Azure output-limit responses as reachable", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue({
      ok: false,
      status: 400,
      headers: new Headers(),
      text: async () =>
        "Could not finish the message because max_tokens or model output limit was reached.",
    } as unknown as Response);

    const status = await createAzureOpenAiProvider({ timeoutMs: 1000 }).healthCheck();

    expect(status.configured).toBe(true);
    expect(status.reachable).toBe(true);
    expect(status.error).toBeUndefined();
  });

  test("healthCheck treats Azure HTTP 4xx as unreachable", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue({
      ok: false,
      status: 401,
      headers: new Headers(),
      text: async () => "invalid api key",
    } as unknown as Response);

    const status = await createAzureOpenAiProvider({ timeoutMs: 1000 }).healthCheck();

    expect(status.configured).toBe(true);
    expect(status.reachable).toBe(false);
    expect(status.error).toContain("Azure OpenAI HTTP 401");
  });

  describe("azure-openai-config edge cases", () => {
    test("cooldown expires and deletes cooldown entry", async () => {
      const config = await import("../src/modules/llm/providers/azure-openai-config.js");
      groupedConfig.azureOpenAi.apiKey = "";
      groupedConfig.azureOpenAi.deployments = [
        {
          apiKey: "key1",
          apiBaseUrl: "https://test.openai.azure.com",
          apiPath: "/openai/deployments",
          model: "gpt-4",
          apiVersion: "2023-05-15",
        },
      ];
      const deployment = config.configuredAzureOpenAiDeployments()[0];

      // rate limit it for 1 second
      config.markAzureOpenAiDeploymentRateLimited(deployment, { retryAfterSeconds: 1 });

      // it should be cooling down
      expect(config.azureOpenAiDeploymentsForTask(null)).toEqual([]);

      // mock Date.now to be 2 seconds in the future
      const originalNow = Date.now;
      Date.now = () => originalNow() + 2000;
      try {
        // should delete cooldown entry and return the deployment
        expect(config.azureOpenAiDeploymentsForTask(null)).toEqual([deployment]);
      } finally {
        Date.now = originalNow;
      }
    });

    test("azureOpenAiCooldownError formats timestamp suffix", async () => {
      const config = await import("../src/modules/llm/providers/azure-openai-config.js");
      groupedConfig.azureOpenAi.deployments = [
        {
          apiKey: "key1",
          apiBaseUrl: "https://test.openai.azure.com",
          apiPath: "/openai/deployments",
          model: "gpt-4",
          apiVersion: "2023-05-15",
        },
      ];
      const deployment = config.configuredAzureOpenAiDeployments()[0];
      config.markAzureOpenAiDeploymentRateLimited(deployment, { retryAfterSeconds: 60 });

      const err = config.azureOpenAiCooldownError();
      expect(err.message).toContain("Azure OpenAI deployments are cooling down until");
    });

    test("azureOpenAiDeploymentAuditLabel handles invalid URL", async () => {
      const config = await import("../src/modules/llm/providers/azure-openai-config.js");
      const label = config.azureOpenAiDeploymentAuditLabel({
        apiKey: "k",
        apiBaseUrl: "invalid-url-string",
        apiPath: "p",
        apiVersion: "v",
        model: "m",
      });
      expect(label.host).toBe("invalid-url-string");
    });
  });
});
