import { beforeEach, describe, expect, test, vi } from "vitest";
import { createBedrockProvider } from "../src/modules/llm/providers/bedrock.provider.js";

const mockSend = vi.fn();

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
  const BedrockRuntimeClientMock = vi.fn(function BedrockRuntimeClientMock() {
    return { send: mockSend };
  });
  const ConverseCommandMock = vi.fn(function ConverseCommandMock(this: { input?: unknown }, input) {
    this.input = input;
  });
  return {
    BedrockRuntimeClient: BedrockRuntimeClientMock,
    ConverseCommand: ConverseCommandMock,
  };
});

vi.mock("../src/config.js", () => ({
  groupedConfig: {
    bedrock: {
      region: "us-east-1",
      model: "anthropic.claude-3-sonnet",
      profile: "",
    },
  },
}));

describe("bedrock provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
  });

  test("chat sends ConverseCommand and extracts text", async () => {
    const provider = createBedrockProvider();
    const mockResponse = {
      output: {
        message: {
          content: [{ text: "Hello from Bedrock" }],
        },
      },
      stopReason: "end_turn",
    };

    mockSend.mockResolvedValue(mockResponse);

    const result = await provider.chat({
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 100,
    });

    expect(mockSend).toHaveBeenCalled();
    expect(result.content).toBe("Hello from Bedrock");
    expect(result.finishReason).toBe("end_turn");
  });

  test("chat throws error on empty response", async () => {
    const provider = createBedrockProvider();
    const mockResponse = { output: { message: { content: [] } } };
    mockSend.mockResolvedValue(mockResponse);

    await expect(
      provider.chat({ messages: [{ role: "user", content: "hi" }], maxTokens: 10 }),
    ).rejects.toThrow("Bedrock returned empty response");
  });

  test("healthCheck returns reachable true if chat succeeds", async () => {
    const provider = createBedrockProvider();
    const mockResponse = { output: { message: { content: [{ text: "pong" }] } } };
    mockSend.mockResolvedValue(mockResponse);

    const status = await provider.healthCheck();
    expect(status.reachable).toBe(true);
  });

  test("healthCheck returns reachable true on client errors (permissions/throttling)", async () => {
    const provider = createBedrockProvider();
    const error = new Error("Access Denied");
    (error as any).name = "AccessDeniedException";
    mockSend.mockRejectedValue(error);

    const status = await provider.healthCheck();
    expect(status.reachable).toBe(true); // Reachable but denied
  });

  test("healthCheck returns error on connection/unexpected errors", async () => {
    const provider = createBedrockProvider();
    mockSend.mockRejectedValue(new Error("Connection Failed"));

    const status = await provider.healthCheck();
    expect(status.reachable).toBe(false);
    expect(status.error).toBe("Connection Failed");
  });
});
