import { beforeEach, describe, expect, test, vi } from "vitest";
import { callAzureOpenAiChat } from "../src/modules/distillation/providers/azure-openai.js";

vi.mock("../src/config.js", () => ({
  groupedConfig: {
    azureOpenAi: {
      apiKey: "test-api-key",
      apiBaseUrl: "https://test-endpoint.openai.azure.com",
      apiPath: "/openai/deployments",
      model: "gpt-4",
      apiVersion: "2023-05-15",
    },
    distillation: {
      timeoutMs: 1000,
    },
  },
}));

describe("azure openai provider", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
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
    expect(body.tool_choice).toBe("none");
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
});
