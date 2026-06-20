import { recordCompileEval } from "../../modules/context-compiler/context-compile-eval.service.js";
import { compileEvalInputSchema } from "../../shared/schemas/context-compile-eval.schema.js";
import type { ToolEntry } from "../registry.js";

export const compileEvalTool: ToolEntry = {
  name: "compile_eval",
  description:
    "Evaluate returned context from a context_compile run. Do not call this tool when context_compile returned No Content.",
  inputSchema: {
    type: "object",
    properties: {
      runId: { type: "string", format: "uuid" },
      outcome: { type: "string", enum: ["useful", "partial", "misleading", "unused"] },
      title: { type: "string", maxLength: 160 },
      body: { type: "string", maxLength: 10000 },
      relevance: {
        type: "integer",
        minimum: 0,
        maximum: 100,
        description: "目的に合っていたか (0-100)",
      },
      actionability: {
        type: "integer",
        minimum: 0,
        maximum: 100,
        description: "実装・判断に使えたか (0-100)",
      },
      coverage: {
        type: "integer",
        minimum: 0,
        maximum: 100,
        description: "必要情報を網羅していたか (0-100)",
      },
      clarity: {
        type: "integer",
        minimum: 0,
        maximum: 100,
        description: "Context clarity (100 = clean, 0 = noisy).",
      },
      specificity: {
        type: "integer",
        minimum: 0,
        maximum: 100,
        description: "抽象すぎなかったか (0-100)",
      },
    },
    required: [
      "outcome",
      "body",
      "relevance",
      "actionability",
      "coverage",
      "clarity",
      "specificity",
    ],
  },
  handler: async (args, context) => {
    const input = compileEvalInputSchema.parse(args ?? {});
    const result = await recordCompileEval({
      input,
      requestMeta: context?.requestMeta,
      source: "mcp",
    });
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
};
