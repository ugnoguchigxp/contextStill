import { z } from "zod";
import {
  recordActivityWithArtifacts,
  retrieveActivityContext,
} from "../../modules/activity/activity.service.js";
import { db } from "../../db/client.js";
import { aiArtifacts, artifactSymbols, vibeMemories } from "../../db/schema.js";
import { desc, eq, inArray } from "drizzle-orm";
import { recordActivityInputSchema } from "../../shared/schemas/activity.schema.js";

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

const recordVibeMemoryArgsSchema = recordActivityInputSchema;

export const memorySearchTool = {
  name: "memory_search",
  description: "Search for past agent activities and vibe memories (Gnosis compatible).",
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
    const results = await retrieveActivityContext({
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
    const artifacts = await db
      .select()
      .from(aiArtifacts)
      .where(eq(aiArtifacts.vibeMemoryId, memory.id))
      .orderBy(desc(aiArtifacts.createdAt));
    const artifactIds = artifacts.map((artifact) => artifact.id);
    const symbols =
      artifactIds.length > 0
        ? await db
            .select()
            .from(artifactSymbols)
            .where(inArray(artifactSymbols.artifactId, artifactIds))
            .orderBy(desc(artifactSymbols.updatedAt))
        : [];

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
              artifacts: artifacts.map((artifact) => ({
                ...artifact,
                symbols: symbols.filter((symbol) => symbol.artifactId === artifact.id),
              })),
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
  description: "Record agent activity/vibe memory to the database (Gnosis compatible).",
  inputSchema: {
    type: "object",
    properties: {
      sessionId: { type: "string", description: "The current session or task ID." },
      content: { type: "string", description: "The log message, chat content, or action detail." },
      memoryType: {
        type: "string",
        enum: ["chat", "action", "observation", "system"],
        default: "chat",
      },
      metadata: { type: "object", description: "Optional metadata." },
      diff: {
        type: "string",
        description: "Optional unified diff. Changed files are stored as AI artifacts.",
      },
      artifacts: {
        type: "array",
        description: "Optional explicit artifacts with content, diff, language, and symbols.",
        items: {
          type: "object",
          properties: {
            filePath: { type: "string" },
            content: { type: "string" },
            diff: { type: "string" },
            language: { type: "string" },
            metadata: { type: "object" },
            symbols: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  symbolName: { type: "string" },
                  symbolKind: { type: "string" },
                  content: { type: "string" },
                  signature: { type: "string" },
                  startLine: { type: "number" },
                  endLine: { type: "number" },
                  metadata: { type: "object" },
                },
                required: ["symbolName", "symbolKind"],
              },
            },
          },
          required: ["filePath"],
        },
      },
    },
    required: ["sessionId", "content"],
  },
  handler: async (args: unknown) => {
    const parsed = recordVibeMemoryArgsSchema.parse(args);
    const result = await recordActivityWithArtifacts(parsed);
    const symbolCount = result.artifacts.reduce(
      (count, artifact) => count + artifact.symbols.length,
      0,
    );
    return {
      content: [
        {
          type: "text",
          text: `Vibe memory recorded with ID: ${result.memory.id} (artifacts: ${result.artifacts.length}, symbols: ${symbolCount})`,
        },
      ],
    };
  },
};
