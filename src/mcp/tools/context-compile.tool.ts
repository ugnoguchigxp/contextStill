import { compileContextPack } from "../../modules/context-compiler/context-compiler.service.js";
import { compileInputSchema } from "../../shared/schemas/compile.schema.js";
import type { ToolEntry } from "../registry.js";

export const contextCompileTool: ToolEntry = {
  name: "context_compile",
  description:
    "Compile minimal context pack from knowledge, source references, and retrieval stats.",
  inputSchema: {
    type: "object",
    properties: {
      goal: { type: "string" },
      intent: { type: "string", enum: ["plan", "edit", "debug", "review", "finish"] },
      retrievalMode: {
        type: "string",
        enum: [
          "task_context",
          "review_context",
          "debug_context",
          "architecture_context",
          "procedure_context",
          "learning_context",
        ],
      },
      repoPath: { type: "string" },
      files: { type: "array", items: { type: "string" } },
      changeTypes: { type: "array", items: { type: "string" } },
      technologies: { type: "array", items: { type: "string" } },
      tokenBudget: { type: "number" },
      includeDraft: { type: "boolean" },
      queryEmbedding: { type: "array", items: { type: "number" } },
    },
    required: ["goal"],
  },
  handler: async (args) => {
    const parsed = compileInputSchema.parse(args ?? {});
    const { pack, markdown } = await compileContextPack(parsed);
    return {
      content: [
        { type: "text", text: JSON.stringify(pack, null, 2) },
        { type: "text", text: markdown },
      ],
    };
  },
};
