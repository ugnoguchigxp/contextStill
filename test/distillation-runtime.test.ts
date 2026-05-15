import { describe, expect, test } from "vitest";
import { buildDistillationSystemPrompt } from "../src/modules/distillation/distillation-prompts.js";
import {
  runDistillationCompletion,
  type DistillationChatClient,
  type DistillationToolExecutor,
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

    expect(prompt).toContain("Allowed knowledge types are exactly: rule, procedure");
    expect(prompt).toContain("context_compile");
    expect(prompt).toContain("search_web");
    expect(prompt).toContain("fetch_content");
    expect(prompt).not.toMatch(/\bfact\b/i);
    expect(prompt).not.toMatch(/\blesson\b/i);
  });
});
