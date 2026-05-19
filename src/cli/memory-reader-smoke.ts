import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import { groupedConfig } from "../config.js";
import { closeDbPool, db } from "../db/index.js";
import { agentDiffEntries, vibeMemories } from "../db/schema.js";
import { buildVibeReaderContext } from "../modules/distillation/distillation-reader.service.js";
import { sliceTextByTokenWindow } from "../modules/readFile/token-window.service.js";

type FlatReadResult = {
  content: string;
  totalTokens: number;
  from: number;
  toExclusive: number;
  returnedTokens: number;
};

const firstWindowTokens = groupedConfig.readFile.defaultTokens;
const sessionInputSize = sql<number>`
  sum(
    length(${vibeMemories.content}) + coalesce((
      select sum(length(${agentDiffEntries.diffHunk}))
      from ${agentDiffEntries}
      where ${agentDiffEntries.vibeMemoryId} = ${vibeMemories.id}
    ), 0)
  )::int
`;

function toFlatReadResult(params: {
  text: string;
  fromToken: number;
  readTokens: number;
}): FlatReadResult {
  const window = sliceTextByTokenWindow({
    text: params.text,
    fromToken: params.fromToken,
    readTokens: params.readTokens,
  });
  return {
    content: window.content,
    totalTokens: window.totalTokens,
    from: window.tokenRange.from,
    toExclusive: window.tokenRange.toExclusive,
    returnedTokens: window.returnedTokens,
  };
}

async function loadLongestSessionId(): Promise<string> {
  const [session] = await db
    .select({
      sessionId: vibeMemories.sessionId,
      totalChars: sessionInputSize,
    })
    .from(vibeMemories)
    .groupBy(vibeMemories.sessionId)
    .orderBy(desc(sessionInputSize))
    .limit(1);

  if (!session?.sessionId) {
    throw new Error("No vibe memories found.");
  }
  return session.sessionId;
}

async function loadMemoriesInSession(sessionId: string) {
  const memories = await db
    .select()
    .from(vibeMemories)
    .where(eq(vibeMemories.sessionId, sessionId))
    .orderBy(asc(vibeMemories.createdAt), asc(vibeMemories.id));

  if (memories.length === 0) {
    throw new Error(`No vibe memories found in session: ${sessionId}`);
  }
  return memories;
}

async function loadDiffEntries(vibeMemoryIds: string[]) {
  return db
    .select()
    .from(agentDiffEntries)
    .where(inArray(agentDiffEntries.vibeMemoryId, vibeMemoryIds))
    .orderBy(
      asc(agentDiffEntries.createdAt),
      asc(agentDiffEntries.vibeMemoryId),
      asc(agentDiffEntries.filePath),
      asc(agentDiffEntries.id),
    );
}

function renderMemoryContextSegments(params: {
  memory: typeof vibeMemories.$inferSelect;
  diffEntries: Array<typeof agentDiffEntries.$inferSelect>;
  mode: "compressed" | "original";
}): string[] {
  const context = buildVibeReaderContext({
    memory: params.memory,
    diffEntries: params.diffEntries,
    apply: false,
    mode: params.mode,
  });
  return context.segments.map((segment) => segment.content);
}

function renderSessionContextText(params: {
  memories: Array<typeof vibeMemories.$inferSelect>;
  diffEntries: Array<typeof agentDiffEntries.$inferSelect>;
  mode: "compressed" | "original";
}): string {
  const diffsByMemoryId = new Map<string, Array<typeof agentDiffEntries.$inferSelect>>();
  for (const entry of params.diffEntries) {
    const current = diffsByMemoryId.get(entry.vibeMemoryId) ?? [];
    current.push(entry);
    diffsByMemoryId.set(entry.vibeMemoryId, current);
  }

  const seenCompressedSegments = new Set<string>();
  const rendered: string[] = [];

  for (const memory of params.memories) {
    const segments = renderMemoryContextSegments({
      memory,
      diffEntries: diffsByMemoryId.get(memory.id) ?? [],
      mode: params.mode,
    });
    for (const segment of segments) {
      const trimmed = segment.trim();
      if (!trimmed) continue;
      if (params.mode === "compressed") {
        if (seenCompressedSegments.has(trimmed)) continue;
        seenCompressedSegments.add(trimmed);
      }
      rendered.push(segment);
    }
  }

  return rendered.join("\n");
}

async function main(): Promise<void> {
  const sessionId = await loadLongestSessionId();
  const memories = await loadMemoriesInSession(sessionId);
  const diffEntries = await loadDiffEntries(memories.map((memory) => memory.id));

  const compressedText = renderSessionContextText({
    memories,
    diffEntries,
    mode: "compressed",
  });
  const originalText = renderSessionContextText({
    memories,
    diffEntries,
    mode: "original",
  });

  const first = toFlatReadResult({
    text: compressedText,
    fromToken: 0,
    readTokens: firstWindowTokens,
  });
  process.stdout.write(`${JSON.stringify(first, null, 2)}\n`);

  const second = toFlatReadResult({
    text: originalText,
    fromToken: 0,
    readTokens: firstWindowTokens,
  });
  process.stdout.write(`${JSON.stringify(second, null, 2)}\n`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbPool();
  });
