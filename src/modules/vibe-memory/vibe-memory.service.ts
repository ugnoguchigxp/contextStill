import { db } from "../../db/client.js";
import { agentDiffEntries, vibeMemories } from "../../db/schema.js";
import {
  type RecordVibeMemoryInput,
  recordVibeMemoryInputSchema,
} from "../../shared/schemas/vibe-memory.schema.js";
import {
  extractAgentDiffContentFromText,
  normalizeAgentDiffEntries,
  stripAgentDiffContentFromText,
} from "./agent-diff-ingestion.service.js";
import {
  type VibeMemorySeed,
  insertVibeMemory,
  searchVibeMemories,
} from "./vibe-memory.repository.js";

export type RecordedVibeMemory = {
  memory: typeof vibeMemories.$inferSelect;
  diffEntries: (typeof agentDiffEntries.$inferSelect)[];
};

export async function recordVibeMemory(memory: VibeMemorySeed) {
  return insertVibeMemory(memory);
}

export async function recordVibeMemoryWithDiffEntries(
  input: RecordVibeMemoryInput,
): Promise<RecordedVibeMemory> {
  const parsed = recordVibeMemoryInputSchema.parse(input);
  const embeddedDiff = extractAgentDiffContentFromText(parsed.content);
  const normalizedEntries = normalizeAgentDiffEntries({
    diff: [parsed.diff, embeddedDiff]
      .filter((diff): diff is string => Boolean(diff?.trim()))
      .join("\n\n"),
    agentDiffs: parsed.agentDiffs,
  });
  const content =
    stripAgentDiffContentFromText(parsed.content) ||
    (normalizedEntries.length > 0 ? "Agent diff recorded." : parsed.content.trim());

  return db.transaction(async (tx) => {
    const [memory] = await tx
      .insert(vibeMemories)
      .values({
        sessionId: parsed.sessionId,
        content,
        memoryType: parsed.memoryType,
        metadata: parsed.metadata,
      })
      .returning();

    const diffEntries =
      normalizedEntries.length > 0
        ? await tx
            .insert(agentDiffEntries)
            .values(
              normalizedEntries.map((entry) => ({
                vibeMemoryId: memory.id,
                filePath: entry.filePath,
                diffHunk: entry.diffHunk,
                changeType: entry.changeType ?? null,
                language: entry.language ?? null,
                symbolName: entry.symbolName ?? null,
                symbolKind: entry.symbolKind ?? null,
                signature: entry.signature ?? null,
                startLine: entry.startLine ?? null,
                endLine: entry.endLine ?? null,
                metadata: entry.metadata,
              })),
            )
            .returning()
        : [];

    return { memory, diffEntries };
  });
}

export async function retrieveVibeMemoryContext(params: {
  query: string;
  sessionId?: string;
  limit?: number;
}) {
  const limit = params.limit ?? 10;
  const memories = await searchVibeMemories({
    query: params.query,
    sessionId: params.sessionId,
    limit,
  });

  return memories.map((m) => ({
    id: m.id,
    sessionId: m.sessionId,
    content: m.content,
    memoryType: m.memoryType,
    createdAt: m.createdAt,
    score: m.score,
  }));
}
