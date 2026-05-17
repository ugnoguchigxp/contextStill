import { describe, expect, test } from "vitest";
import {
  buildDistillationExtractionSystemPrompt,
  buildDistillationSystemPrompt,
  buildDistillationVerificationSystemPrompt,
} from "../src/modules/distillation/distillation-prompts.js";
import {
  type DistillationChatClient,
  type DistillationToolExecutor,
  buildBedrockConversation,
  buildBedrockToolConfig,
  distillationToolEventsFromError,
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
    const toolExecutor: DistillationToolExecutor = async (toolCall, auditContext) => {
      expect(auditContext).toMatchObject({ candidateRowId: "candidate-1" });
      return {
        callId: toolCall.id,
        name: toolCall.function.name,
        ok: true,
        content: '{"url":"https://example.com/docs","text":"Fetched documentation body"}',
      };
    };

    const result = await runDistillationCompletion(
      {
        model: "gemma-4-e4b-it",
        messages: [
          { role: "system", content: "Return JSON." },
          { role: "user", content: "https://example.com/docs" },
        ],
        maxTokens: 256,
      },
      {
        chatClient,
        toolExecutor,
        maxToolRounds: 2,
        auditContext: { candidateRowId: "candidate-1" },
      },
    );

    expect(result.content).toContain('"candidates"');
    expect(result.toolEvents).toHaveLength(1);
    expect(result.messages.some((message) => message.role === "tool")).toBe(true);
  });

  test("can require the first verification round to call a tool", async () => {
    const seenToolChoices: unknown[] = [];
    const chatClient: DistillationChatClient = async (request) => {
      seenToolChoices.push(request.toolChoice);
      if (seenToolChoices.length === 1) {
        return {
          content: null,
          toolCalls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "search_web", arguments: '{"query":"memory router"}' },
            },
          ],
        };
      }
      return {
        content: '{"candidates":[]}',
        toolCalls: [],
      };
    };
    const toolExecutor: DistillationToolExecutor = async (toolCall) => ({
      callId: toolCall.id,
      name: toolCall.function.name,
      ok: true,
      content: "Search evidence",
    });

    await runDistillationCompletion(
      { model: "m", messages: [{ role: "user", content: "verify" }], maxTokens: 10 },
      { chatClient, toolExecutor, requireToolCall: true },
    );

    expect(seenToolChoices).toEqual(["required", "auto"]);
  });

  test("reprompts once when required tool use is skipped", async () => {
    const seenToolChoices: unknown[] = [];
    const seenMessages: string[][] = [];
    const chatClient: DistillationChatClient = async (request) => {
      seenToolChoices.push(request.toolChoice);
      seenMessages.push(request.messages.map((message) => String(message.content ?? "")));
      if (seenToolChoices.length === 1) {
        return {
          content: '{"candidates":[{"type":"rule","title":"Premature","body":"No tool yet"}]}',
          toolCalls: [],
        };
      }
      if (seenToolChoices.length === 2) {
        expect(request.messages.at(-1)?.content).toContain("tool call が必須");
        return {
          content: null,
          toolCalls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "search_web", arguments: '{"query":"memory router"}' },
            },
          ],
        };
      }
      return {
        content: '{"candidates":[]}',
        toolCalls: [],
      };
    };
    const toolExecutor: DistillationToolExecutor = async (toolCall) => ({
      callId: toolCall.id,
      name: toolCall.function.name,
      ok: true,
      content: "Search evidence",
    });

    const result = await runDistillationCompletion(
      { model: "m", messages: [{ role: "user", content: "verify" }], maxTokens: 10 },
      { chatClient, toolExecutor, requireToolCall: true },
    );

    expect(result.toolEvents).toHaveLength(1);
    expect(seenToolChoices).toEqual(["required", "required", "auto"]);
    expect(seenMessages[1]?.some((content) => content.includes("直前の応答"))).toBe(true);
  });

  test("reprompts once when the final assistant response is blank", async () => {
    const seenMessages: string[][] = [];
    const chatClient: DistillationChatClient = async (request) => {
      seenMessages.push(request.messages.map((message) => String(message.content ?? "")));
      if (seenMessages.length === 1) {
        return {
          content: "",
          toolCalls: [],
        };
      }
      expect(request.messages.at(-1)?.content).toContain("TYPE: rule");
      expect(request.messages.at(-1)?.content).toContain(
        "TYPE / TITLE / BODY のような見出し行だけを出さない",
      );
      return {
        content: '{"candidates":[]}',
        toolCalls: [],
      };
    };

    const result = await runDistillationCompletion(
      {
        model: "m",
        messages: [{ role: "user", content: "distill" }],
        maxTokens: 10,
      },
      { chatClient },
    );

    expect(result.content).toBe('{"candidates":[]}');
    expect(seenMessages).toHaveLength(2);
  });

  test("common system prompt keeps output constrained to compile-ready rule/procedure", () => {
    const prompt = buildDistillationSystemPrompt("vibe_memory");

    expect(prompt).toContain("知識タイプは rule と procedure のみ");
    expect(prompt).toContain("context_compile");
    expect(prompt).toContain("search_web");
    expect(prompt).toContain("fetch_content");
    expect(prompt).toContain("tool call JSON");
    expect(prompt).toContain("title/body に search_web、fetch_content、read_source_segment");
    expect(prompt).toContain("可能な限り日本語");
    expect(prompt).not.toMatch(/\bfact\b/i);
    expect(prompt).not.toMatch(/\blesson\b/i);
  });

  test("extraction and verification prompts split source-first and tool-backed sessions", () => {
    const extractionPrompt = buildDistillationExtractionSystemPrompt("wiki");
    const procedureVerificationPrompt = buildDistillationVerificationSystemPrompt("procedure");

    expect(extractionPrompt).toContain("1 段階目の候補抽出セッション");
    expect(extractionPrompt).toContain("入力証拠だけから候補を抽出");
    expect(extractionPrompt).not.toContain("fetch_content の成功結果を必須");
    expect(procedureVerificationPrompt).toContain("2 段階目の新しいセッション");
    expect(procedureVerificationPrompt).toContain("tool result を受け取る前");
    expect(procedureVerificationPrompt).toContain("search_web");
    expect(procedureVerificationPrompt).toContain("fetch_content");
    expect(procedureVerificationPrompt).toContain('"name":"search_web"');
    expect(procedureVerificationPrompt).toContain("中間応答専用");
    expect(procedureVerificationPrompt).toContain("最終 candidates にコピーしてはいけない");
    expect(procedureVerificationPrompt).toContain("SKILL.md");
    expect(procedureVerificationPrompt).toContain("順序付きワークフロー");
    expect(procedureVerificationPrompt).toContain(
      "最終 knowledge に必要な情報は type / title / body / confidence / importance",
    );
    expect(procedureVerificationPrompt).not.toContain("sourceRefs");
    expect(procedureVerificationPrompt).not.toContain("evidenceRefs");
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

    let thrown: unknown;
    try {
      await runDistillationCompletion(
        { model: "m", messages: [], maxTokens: 10 },
        { chatClient, toolExecutor, maxToolRounds: 1 },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("distillation tool loop exceeded max rounds");
    expect(distillationToolEventsFromError(thrown)).toHaveLength(1);
    expect(distillationToolEventsFromError(thrown)[0]).toMatchObject({ name: "t", ok: true });
  });

  test("throws error when response content is missing", async () => {
    const chatClient: DistillationChatClient = async () => ({
      content: null,
      toolCalls: [],
    });

    let thrown: unknown;
    try {
      await runDistillationCompletion({ model: "m", messages: [], maxTokens: 10 }, { chatClient });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain(
      "distillation response did not include assistant content",
    );
    expect(distillationToolEventsFromError(thrown)).toHaveLength(0);
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

    test("buildBedrockToolConfig can require a tool call", () => {
      const tools: any[] = [
        { function: { name: "t1", description: "d1", parameters: { type: "object" } } },
      ];
      const result = buildBedrockToolConfig(tools, "required");
      expect(result?.toolChoice).toEqual({ any: {} });
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
