import { z } from "zod";
import {
  recordActivity,
  retrieveActivityContext,
} from "../../modules/activity/activity.service.js";
import { db } from "../../db/client.js";
import { vibeMemories } from "../../db/schema.js";
import { eq } from "drizzle-orm";

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
  handler: async (args: any) => {
    const results = await retrieveActivityContext({
      query: args.query,
      sessionId: args.sessionId,
      limit: args.limit,
    });
    return {
      content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
    };
  },
};

export const memoryFetchTool = {
  name: "memory_fetch",
  description: "Fetch a specific vibe memory with optional range or search context (Gnosis compatible).",
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
  handler: async (args: any) => {
    const [memory] = await db.select().from(vibeMemories).where(eq(vibeMemories.id, args.id));
    if (!memory) {
      return { content: [{ type: "text", text: "Memory not found." }], isError: true };
    }

    let text = memory.content;
    const start = args.start ?? 0;
    const end = args.end ?? text.length;

    if (args.query) {
      const index = text.toLowerCase().indexOf(args.query.toLowerCase());
      if (index !== -1) {
        const half = (args.maxChars ?? 1000) / 2;
        text = text.slice(Math.max(0, index - half), index + half);
      } else {
        text = text.slice(start, end);
      }
    } else {
      text = text.slice(start, end);
    }

    if (args.maxChars && text.length > args.maxChars) {
      text = text.slice(0, args.maxChars);
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ ...memory, content: text }, null, 2),
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
    },
    required: ["sessionId", "content"],
  },
  handler: async (args: any) => {
    const result = await recordActivity({
      sessionId: args.sessionId,
      content: args.content,
      memoryType: args.memoryType,
      metadata: args.metadata,
    });
    return {
      content: [{ type: "text", text: `Vibe memory recorded with ID: ${result.id}` }],
    };
  },
};
