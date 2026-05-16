import { describe, expect, test } from "vitest";
import { buildDistillationSystemPrompt } from "../src/modules/distillation/distillation-prompts.js";
import {
  type DistillationChatClient,
  type DistillationToolExecutor,
  buildBedrockConversation,
  buildBedrockToolConfig,
  parseBedrockResponse,
  parseOpenAiStyleResponse,
  parseToolCalls,
  runDistillationCompletion,
} from "../src/modules/distillation/distillation-runtime.service.js";

describe("distillation runtime", () => {
  test("executes tool calls and feeds results back before final JSON", async () => {
    const seenMessages: unknown[] = [];
    const chatClient: DistillationChatClient = async (request) => {
      seenMessages.push(request.messages.map((message) => ({ ...message })));
      if (seenMessages.length === 1) {
        expect(request.tools?.map((tool) => tool.function.name)).toEqual([
          "search_web",
          "fetch_content",
        ]);
        return {
          content: null,
          finishReason: "tool_calls",
          toolCalls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "fetch_content",
                arguments: '{"url":"https://example.com/docs"}',
              },
            },
          ],
        };
      }

      expect(request.toolChoice).toBe("auto");
      expect(request.messages.some((message) => message.role === "tool")).toBe(true);
      return {
        content:
          '{"candidates":[{"type":"rule","title":"Use cited docs","body":"Use fetched documentation before preserving external behavior claims.","confidence":90,"importance":70}]}',
        finishReason: "stop",
        toolCalls: [],
      };
    };
    const toolExecutor: DistillationToolExecutor = async (toolCall) => ({
      callId: toolCall.id,
      name: toolCall.function.name,
      ok: true,
      content: '{"url":"https://example.com/docs","text":"Fetched documentation body"}',
    });

    const result = await runDistillationCompletion(
      {
        model: "gemma-4-e4b-it",
        messages: [
          { role: "system", content: "Return JSON." },
          { role: "user", content: "https://example.com/docs" },
        ],
        maxTokens: 256,
      },
      { chatClient, toolExecutor, maxToolRounds: 2 },
    );

    expect(result.content).toContain('"candidates"');
    expect(result.toolEvents).toHaveLength(1);
    expect(result.messages.some((message) => message.role === "tool")).toBe(true);
  });

  test("common system prompt keeps output constrained to compile-ready rule/procedure", () => {
    const prompt = buildDistillationSystemPrompt("vibe_memory");

    expect(prompt).toContain("知識タイプは rule と procedure のみ");
    expect(prompt).toContain("context_compile");
    expect(prompt).toContain("search_web");
    expect(prompt).toContain("fetch_content");
    expect(prompt).toContain("可能な限り日本語");
    expect(prompt).not.toMatch(/\bfact\b/i);
    expect(prompt).not.toMatch(/\blesson\b/i);
  });

  test("throws error when tool rounds exceeded", async () => {
    const chatClient: DistillationChatClient = async () => ({
      content: null,
      toolCalls: [{ id: "c1", type: "function", function: { name: "t", arguments: "{}" } }],
    });
    const toolExecutor: DistillationToolExecutor = async () => ({
      callId: "c1",
      name: "t",
      ok: true,
      content: "",
    });

    await expect(
      runDistillationCompletion(
        { model: "m", messages: [], maxTokens: 10 },
        { chatClient, toolExecutor, maxToolRounds: 1 },
      ),
    ).rejects.toThrow("distillation tool loop exceeded max rounds");
  });

  test("throws error when response content is missing", async () => {
    const chatClient: DistillationChatClient = async () => ({
      content: null,
      toolCalls: [],
    });
    await expect(
      runDistillationCompletion({ model: "m", messages: [], maxTokens: 10 }, { chatClient }),
    ).rejects.toThrow("distillation response did not include assistant content");
  });

  describe("parsing helpers", () => {
    test("parseToolCalls extracts function info", () => {
      const raw = [
        {
          id: "call_1",
          type: "function",
          function: { name: "test_tool", arguments: '{"a":1}' },
        },
      ];
      const result = parseToolCalls(raw);
      expect(result).toHaveLength(1);
      expect(result[0].function.name).toBe("test_tool");
      expect(result[0].function.arguments).toBe('{"a":1}');
    });

    test("parseOpenAiStyleResponse maps choices to chat response", () => {
      const raw = {
        choices: [{ message: { content: "hello", tool_calls: [] }, finish_reason: "stop" }],
      };
      const result = parseOpenAiStyleResponse(raw);
      expect(result.content).toBe("hello");
      expect(result.finishReason).toBe("stop");
    });
  });

  describe("bedrock conversion", () => {
    test("buildBedrockConversation handles system, user, assistant and tool messages", () => {
      const messages: any[] = [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "ok",
          tool_calls: [{ id: "c1", function: { name: "t", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "c1", content: "done" },
      ];
      const result = buildBedrockConversation(messages);

      expect(result.system).toEqual([{ text: "sys" }]);
      expect(result.messages).toHaveLength(3); // user, assistant, tool-result-as-user
      expect(result.messages[0].role).toBe("user");
      expect(result.messages[1].role).toBe("assistant");
      expect(result.messages[2].role).toBe("user"); // Bedrock expects tool results as user role
    });

    test("buildBedrockToolConfig maps distillation tools to bedrock specs", () => {
      const tools: any[] = [
        { function: { name: "t1", description: "d1", parameters: { type: "object" } } },
      ];
      const result = buildBedrockToolConfig(tools);
      expect(result?.tools).toHaveLength(1);
      expect((result?.tools?.[0] as any).toolSpec.name).toBe("t1");
    });

    test("parseBedrockResponse extracts text and tool calls", () => {
      const raw = {
        output: {
          message: {
            content: [
              { text: "thinking" },
              { toolUse: { toolUseId: "c1", name: "t1", input: { x: 1 } } },
            ],
          },
        },
        stopReason: "tool_use",
      };
      const result = parseBedrockResponse(raw);
      expect(result.content).toBe("thinking");
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].id).toBe("c1");
      expect(result.toolCalls[0].function.name).toBe("t1");
    });
  });
});
