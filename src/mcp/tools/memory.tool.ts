import { z } from "zod";
import {
  recordVibeMemoryWithDiffEntries,
  retrieveVibeMemoryContext,
} from "../../modules/vibe-memory/vibe-memory.service.js";
import { db } from "../../db/client.js";
import { agentDiffEntries, vibeMemories } from "../../db/schema.js";
import { desc, eq } from "drizzle-orm";
import { recordVibeMemoryInputSchema } from "../../shared/schemas/vibe-memory.schema.js";

const memorySearchArgsSchema = z.object({
  query: z.string().trim().min(1),
  sessionId: z.string().optional(),
  limit: z.number().int().positive().optional(),
});

const memoryFetchArgsSchema = z.object({
  id: z.string().min(1),
  start: z.number().int().nonnegative().optional(),
  end: z.number().int().nonnegative().optional(),
  maxChars: z.number().int().positive().optional(),
  query: z.string().trim().optional(),
});

const recordVibeMemoryArgsSchema = recordVibeMemoryInputSchema;

export const memorySearchTool = {
  name: "memory_search",
  description: "Search past vibe memories and captured agent diffs (Gnosis compatible).",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search term or topic." },
      sessionId: { type: "string", description: "Optional session ID to filter results." },
      limit: { type: "number", default: 10, description: "Maximum number of results to return." },
    },
    required: ["query"],
  },
  handler: async (args: unknown) => {
    const parsed = memorySearchArgsSchema.parse(args);
    const results = await retrieveVibeMemoryContext({
      query: parsed.query,
      sessionId: parsed.sessionId,
      limit: parsed.limit,
    });
    return {
      content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
    };
  },
};

export const memoryFetchTool = {
  name: "memory_fetch",
  description:
    "Fetch a specific vibe memory with optional range or search context (Gnosis compatible).",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Specific memory ID to fetch." },
      start: { type: "number", description: "Start character index." },
      end: { type: "number", description: "End character index." },
      maxChars: { type: "number", description: "Maximum characters to return." },
      query: { type: "string", description: "Fetch context around this query within the memory." },
    },
    required: ["id"],
  },
  handler: async (args: unknown) => {
    const parsed = memoryFetchArgsSchema.parse(args);
    const [memory] = await db.select().from(vibeMemories).where(eq(vibeMemories.id, parsed.id));
    if (!memory) {
      return { content: [{ type: "text", text: "Memory not found." }], isError: true };
    }
    const diffEntries = await db
      .select()
      .from(agentDiffEntries)
      .where(eq(agentDiffEntries.vibeMemoryId, memory.id))
      .orderBy(desc(agentDiffEntries.createdAt));

    let text = memory.content;
    const start = parsed.start ?? 0;
    const end = parsed.end ?? text.length;

    if (parsed.query) {
      const index = text.toLowerCase().indexOf(parsed.query.toLowerCase());
      if (index !== -1) {
        const half = (parsed.maxChars ?? 1000) / 2;
        text = text.slice(Math.max(0, index - half), index + half);
      } else {
        text = text.slice(start, end);
      }
    } else {
      text = text.slice(start, end);
    }

    if (parsed.maxChars && text.length > parsed.maxChars) {
      text = text.slice(0, parsed.maxChars);
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ...memory,
              content: text,
              agentDiffs: diffEntries,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
};

export const recordVibeMemoryTool = {
  name: "record_vibe_memory",
  description: "Record a vibe memory and optional agent diff entries to the database.",
  inputSchema: {
    type: "object",
    properties: {
      sessionId: { type: "string", description: "The current session or task ID." },
      content: {
        type: "string",
        description:
          "The natural-language chat log or action detail. Do not duplicate diff content here; embedded diffs are moved to agent_diff entries.",
      },
      memoryType: {
        type: "string",
        enum: ["chat", "action", "observation", "system"],
        default: "chat",
      },
      metadata: { type: "object", description: "Optional metadata." },
      diff: {
        type: "string",
        description:
          "Optional unified diff. Changed hunks are stored only as agent_diff entries and symbolized when possible.",
      },
      agentDiffs: {
        type: "array",
        description: "Optional explicit diff entries with optional symbol columns.",
        items: {
          type: "object",
          properties: {
            filePath: { type: "string" },
            diffHunk: { type: "string" },
            diff: { type: "string" },
            changeType: { type: "string" },
            language: { type: "string" },
            symbolName: { type: "string" },
            symbolKind: { type: "string" },
            signature: { type: "string" },
            startLine: { type: "number" },
            endLine: { type: "number" },
            metadata: { type: "object" },
          },
          required: ["filePath"],
        },
      },
    },
    required: ["sessionId", "content"],
  },
  handler: async (args: unknown) => {
    const parsed = recordVibeMemoryArgsSchema.parse(args);
    const result = await recordVibeMemoryWithDiffEntries(parsed);
    const symbolCount = result.diffEntries.filter((entry) => entry.symbolName).length;
    return {
      content: [
        {
          type: "text",
          text: `Vibe memory recorded with ID: ${result.memory.id} (agentDiffs: ${result.diffEntries.length}, symbols: ${symbolCount})`,
        },
      ],
    };
  },
};
