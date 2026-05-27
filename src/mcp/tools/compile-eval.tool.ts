import { recordCompileEval } from "../../modules/context-compiler/context-compile-eval.service.js";
import { compileEvalInputSchema } from "../../shared/schemas/context-compile-eval.schema.js";
import type { ToolEntry } from "../registry.js";

export const compileEvalTool: ToolEntry = {
  name: "compile_eval",
  description:
    "Record post-task evaluation for a context_compile run. Stores score, outcome, and rationale.",
  inputSchema: {
    type: "object",
    properties: {
      runId: { type: "string", format: "uuid" },
      score: { type: "integer", minimum: 0, maximum: 100 },
      outcome: { type: "string", enum: ["useful", "partial", "misleading", "unused"] },
      title: { type: "string", maxLength: 160 },
      body: { type: "string", maxLength: 10000 },
    },
    required: ["score", "outcome", "body"],
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
