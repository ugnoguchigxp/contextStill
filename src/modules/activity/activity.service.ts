import {
  type VibeMemorySeed,
  getVibeMemoriesBySession,
  insertVibeMemory,
  searchVibeMemories,
} from "./activity.repository.js";

export async function recordActivity(activity: VibeMemorySeed) {
  return insertVibeMemory(activity);
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
