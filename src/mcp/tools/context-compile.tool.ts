import { compileContextPack } from "../../modules/context-compiler/context-compiler.service.js";
import { reloadRuntimeSettingsCache } from "../../modules/settings/settings.service.js";
import { compileInputSchema } from "../../shared/schemas/compile.schema.js";
import type { ToolEntry } from "../registry.js";

export const contextCompileTool: ToolEntry = {
  name: "context_compile",
  description:
    "Primary workflow tool. Build the minimal task context pack from knowledge + source evidence before coding.",
  inputSchema: {
    type: "object",
    properties: {
      goal: { type: "string" },
      changeTypes: { type: "array", items: { type: "string" } },
      technologies: { type: "array", items: { type: "string" } },
      domains: { type: "array", items: { type: "string" } },
    },
    required: ["goal"],
  },
  handler: async (args) => {
    const parsed = compileInputSchema.parse(args ?? {});
    await reloadRuntimeSettingsCache();
    const { markdown } = await compileContextPack(parsed, { source: "mcp" });
    return {
      content: [{ type: "text", text: markdown }],
    };
  },
};
