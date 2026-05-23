import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/client.js";
import { agentDiffEntries, vibeMemories } from "../../db/schema.js";
import { retrieveVibeMemoryContext } from "../../modules/vibe-memory/vibe-memory.service.js";

const memorySearchArgsSchema = z.object({
  query: z.string().trim().min(1),
  sessionId: z.string().optional(),
  limit: z.number().int().positive().optional(),
  includeContent: z.boolean().optional(),
  previewChars: z.number().int().nonnegative().optional(),
});

const memoryFetchArgsSchema = z.object({
  id: z.string().min(1),
  start: z.number().int().nonnegative().optional(),
  end: z.number().int().nonnegative().optional(),
  maxChars: z.number().int().positive().optional(),
  query: z.string().trim().optional(),
  includeAgentDiffs: z.boolean().optional(),
  returnMetaOnly: z.boolean().optional(),
});

const DEFAULT_PREVIEW_CHARS = 320;
const DEFAULT_QUERY_WINDOW_CHARS = 1000;

function toSingleLineSummary(text: string, maxChars = 140): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3))}...`;
}

function pickTitleFromContent(content: string): string {
  const firstLine = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return "(untitled memory)";
  return toSingleLineSummary(firstLine, 100);
}

async function handleSearchMemory(args: unknown) {
  const parsed = memorySearchArgsSchema.parse(args);
  const results = await retrieveVibeMemoryContext({
    query: parsed.query,
    sessionId: parsed.sessionId,
    limit: parsed.limit,
  });
  if (results.length === 0) {
    return {
      content: [{ type: "text", text: "no content" }],
    };
  }
  const previewChars =
    parsed.previewChars !== undefined ? parsed.previewChars : DEFAULT_PREVIEW_CHARS;
  const items = results.map((item) => {
    const title = pickTitleFromContent(item.content);
    const summary = toSingleLineSummary(item.content, 180);
    const base = {
      id: item.id,
      sessionId: item.sessionId,
      memoryType: item.memoryType,
      createdAt: item.createdAt,
      score: item.score,
      title,
      summary,
    };
    if (!parsed.includeContent) {
      return base;
    }
    return {
      ...base,
      contentPreview: item.content.slice(0, previewChars),
      previewChars,
      contentTruncated: item.content.length > previewChars,
    };
  });
  return {
    content: [{ type: "text", text: JSON.stringify({ items }, null, 2) }],
  };
}

async function handleFetchMemory(args: unknown) {
  const parsed = memoryFetchArgsSchema.parse(args);
  const [memory] = await db.select().from(vibeMemories).where(eq(vibeMemories.id, parsed.id));
  if (!memory) {
    return { content: [{ type: "text", text: "Memory not found." }], isError: true };
  }

  const includeAgentDiffs = parsed.includeAgentDiffs ?? false;
  const diffEntries = includeAgentDiffs
    ? await db
        .select()
        .from(agentDiffEntries)
        .where(eq(agentDiffEntries.vibeMemoryId, memory.id))
        .orderBy(desc(agentDiffEntries.createdAt))
    : [];

  const fullText = memory.content;
  let sliceStart = parsed.start ?? 0;
  let sliceEnd = parsed.end ?? fullText.length;
  const maxChars = parsed.maxChars;

  if (parsed.query) {
    const index = fullText.toLowerCase().indexOf(parsed.query.toLowerCase());
    if (index !== -1) {
      const windowChars = maxChars ?? DEFAULT_QUERY_WINDOW_CHARS;
      const half = Math.floor(windowChars / 2);
      const queryEnd = index + parsed.query.length;
      sliceStart = Math.max(0, index - half);
      sliceEnd = Math.min(fullText.length, queryEnd + half);
    }
  }

  let text = fullText.slice(sliceStart, sliceEnd);
  if (maxChars && text.length > maxChars) {
    text = text.slice(0, maxChars);
    sliceEnd = sliceStart + text.length;
  }
  const truncated = sliceStart > 0 || sliceEnd < fullText.length;

  const payload = parsed.returnMetaOnly
    ? {
        id: memory.id,
        sessionId: memory.sessionId,
        memoryType: memory.memoryType,
        createdAt: memory.createdAt,
        contentLength: fullText.length,
        sliceStart,
        sliceEnd,
        truncated,
      }
    : {
        ...memory,
        content: text,
        sliceStart,
        sliceEnd,
        truncated,
        contentLength: fullText.length,
        ...(includeAgentDiffs ? { agentDiffs: diffEntries } : {}),
      };

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

export const searchMemoryTool = {
  name: "search_memory",
  description: "Search past vibe memories and captured agent diffs (Gnosis compatible).",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search term or topic." },
      sessionId: { type: "string", description: "Optional session ID to filter results." },
      limit: { type: "number", default: 10, description: "Maximum number of results to return." },
      includeContent: {
        type: "boolean",
        default: false,
        description: "Include preview content in results. Defaults to false.",
      },
      previewChars: {
        type: "number",
        description: "Preview length when includeContent=true. Default is 320 chars.",
      },
    },
    required: ["query"],
  },
  handler: handleSearchMemory,
};

export const fetchMemoryTool = {
  name: "fetch_memory",
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
      includeAgentDiffs: {
        type: "boolean",
        default: false,
        description: "Include agent diff entries. Defaults to false.",
      },
      returnMetaOnly: {
        type: "boolean",
        default: false,
        description: "Return metadata only without content text.",
      },
    },
    required: ["id"],
  },
  handler: handleFetchMemory,
};

export const memorySearchTool = {
  ...searchMemoryTool,
  name: "memory_search",
  description: "[Deprecated] Alias of search_memory.",
};

export const memoryFetchTool = {
  ...fetchMemoryTool,
  name: "memory_fetch",
  description: "[Deprecated] Alias of fetch_memory.",
};
