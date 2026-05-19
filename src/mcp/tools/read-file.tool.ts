import { z } from "zod";
import { readFileDomain } from "../../modules/readFile/domain.js";
import type { ToolEntry } from "../registry.js";

const readFileArgsSchema = z.object({
  path: z.string().trim().min(1),
  fromToken: z.number().int().nonnegative().optional(),
  readTokens: z.number().int().positive().optional(),
  includeFrontmatter: z.boolean().optional(),
  minify: z.boolean().optional(),
  minifiy: z.boolean().optional(),
});

export const readFileTool: ToolEntry = {
  name: "read_file",
  description:
    "Read wiki markdown for LLM input with markdownify, optional minify-off, and token-window pagination.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path under configured read-file root." },
      fromToken: { type: "number", description: "Token offset to start reading from." },
      readTokens: { type: "number", description: "Number of tokens to read. Default: 1500." },
      includeFrontmatter: {
        type: "boolean",
        description: "Include YAML frontmatter in source text. Default: false.",
      },
      minify: {
        type: "boolean",
        description: "When false, keep newlines and spacing. Default: true.",
      },
      minifiy: {
        type: "boolean",
        description: "Alias for minify (typo-compatible).",
      },
    },
    required: ["path"],
  },
  handler: async (args) => {
    const parsed = readFileArgsSchema.parse(args ?? {});
    const result = await readFileDomain(parsed);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
};
