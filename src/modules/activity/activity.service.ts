import {
  type VibeMemorySeed,
  getVibeMemoriesBySession,
  insertVibeMemory,
  searchVibeMemories,
} from "./activity.repository.js";
import { db } from "../../db/client.js";
import { aiArtifacts, artifactSymbols, vibeMemories } from "../../db/schema.js";
import {
  recordActivityInputSchema,
  type RecordActivityInput,
} from "../../shared/schemas/activity.schema.js";
import { normalizeActivityArtifacts } from "./artifact-ingestion.service.js";

export type RecordedActivity = {
  memory: typeof vibeMemories.$inferSelect;
  artifacts: Array<
    typeof aiArtifacts.$inferSelect & {
      symbols: (typeof artifactSymbols.$inferSelect)[];
    }
  >;
};

export async function recordActivity(activity: VibeMemorySeed) {
  return insertVibeMemory(activity);
}

export async function recordActivityWithArtifacts(
  input: RecordActivityInput,
): Promise<RecordedActivity> {
  const parsed = recordActivityInputSchema.parse(input);
  const normalizedArtifacts = normalizeActivityArtifacts({
    diff: parsed.diff,
    artifacts: parsed.artifacts,
  });

  return db.transaction(async (tx) => {
    const [memory] = await tx
      .insert(vibeMemories)
      .values({
        sessionId: parsed.sessionId,
        content: parsed.content,
        memoryType: parsed.memoryType,
        metadata: parsed.metadata,
      })
      .returning();

    const storedArtifacts: RecordedActivity["artifacts"] = [];

    for (const artifact of normalizedArtifacts) {
      const [storedArtifact] = await tx
        .insert(aiArtifacts)
        .values({
          vibeMemoryId: memory.id,
          filePath: artifact.filePath,
          content: artifact.content,
          diff: artifact.diff,
          language: artifact.language,
          metadata: artifact.metadata,
        })
        .returning();

      let symbols: (typeof artifactSymbols.$inferSelect)[] = [];
      if (artifact.symbols.length > 0) {
        symbols = await tx
          .insert(artifactSymbols)
          .values(
            artifact.symbols.map((symbol) => ({
              artifactId: storedArtifact.id,
              symbolName: symbol.symbolName,
              symbolKind: symbol.symbolKind,
              content: symbol.content ?? "",
              signature: symbol.signature ?? null,
              startLine: symbol.startLine ?? null,
              endLine: symbol.endLine ?? null,
              metadata: symbol.metadata ?? {},
            })),
          )
          .returning();
      }

      storedArtifacts.push({ ...storedArtifact, symbols });
    }

    return { memory, artifacts: storedArtifacts };
  });
}

export async function retrieveActivityContext(params: {
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

export async function getSessionHistory(sessionId: string) {
  return getVibeMemoriesBySession(sessionId);
}
