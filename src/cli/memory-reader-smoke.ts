import { desc, eq, sql } from "drizzle-orm";
import { groupedConfig } from "../config.js";
import { closeDbPool, db } from "../db/index.js";
import { agentDiffEntries, vibeMemories } from "../db/schema.js";
import { readVibeMemoryByTokenWindow } from "../modules/memoryReader/reader.service.js";

type FlatReadResult = {
  content: string;
  totalTokens: number;
  from: number;
  toExclusive: number;
  returnedTokens: number;
};

const firstWindowTokens = groupedConfig.readFile.defaultTokens;
const sessionInputSizeExpr = sql<number>`
  sum(
    length(${vibeMemories.content}) + coalesce((
      select sum(length(${agentDiffEntries.diffHunk}))
      from ${agentDiffEntries}
      where ${agentDiffEntries.vibeMemoryId} = ${vibeMemories.id}
    ), 0)
  )::int
`;

async function loadLongestSessionId(): Promise<string> {
  const [session] = await db
    .select({
      sessionId: vibeMemories.sessionId,
      totalChars: sessionInputSizeExpr,
    })
    .from(vibeMemories)
    .groupBy(vibeMemories.sessionId)
    .orderBy(desc(sessionInputSizeExpr))
    .limit(1);

  if (!session?.sessionId) {
    throw new Error("No vibe memories found.");
  }
  return session.sessionId;
}

const memoryInputSizeExpr = sql<number>`
  length(${vibeMemories.content}) + coalesce((
    select sum(length(${agentDiffEntries.diffHunk}))
    from ${agentDiffEntries}
    where ${agentDiffEntries.vibeMemoryId} = ${vibeMemories.id}
  ), 0)
`;

async function loadLongestMemoryIdInSession(sessionId: string): Promise<string> {
  const [memory] = await db
    .select()
    .from(vibeMemories)
    .where(eq(vibeMemories.sessionId, sessionId))
    .orderBy(desc(memoryInputSizeExpr), desc(vibeMemories.createdAt), desc(vibeMemories.id))
    .limit(1);
  if (!memory) {
    throw new Error(`No vibe memories found in session: ${sessionId}`);
  }
  return memory.id;
}

function toFlatReadResult(
  result: Awaited<ReturnType<typeof readVibeMemoryByTokenWindow>>,
): FlatReadResult {
  return {
    content: result.content,
    totalTokens: result.totalTokens,
    from: result.from,
    toExclusive: result.toExclusive,
    returnedTokens: result.returnedTokens,
  };
}

async function main(): Promise<void> {
  const sessionId = await loadLongestSessionId();
  const vibeMemoryId = await loadLongestMemoryIdInSession(sessionId);
  const first = toFlatReadResult(
    await readVibeMemoryByTokenWindow({
      vibeMemoryId,
      fromToken: 0,
      readTokens: firstWindowTokens,
      mode: "compressed",
    }),
  );
  process.stdout.write(`${JSON.stringify(first, null, 2)}\n`);

  const second = toFlatReadResult(
    await readVibeMemoryByTokenWindow({
      vibeMemoryId,
      fromToken: 0,
      readTokens: firstWindowTokens,
      mode: "original",
    }),
  );
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
