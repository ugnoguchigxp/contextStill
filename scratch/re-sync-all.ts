import { eq, sql } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { agentDiffEntries, syncStates, vibeMemories } from "../src/db/schema.js";
import { syncAllAgentLogs } from "../src/modules/agent-log-sync/sync.service.js";

async function main() {
  console.log("Resetting sync states and clearing old agent log memories...");

  // Clear only memories/diffs that came from agent logs to avoid destroying manual data
  // But actually, for this task, clearing them all might be cleaner if the user says "not working well"
  await db.delete(agentDiffEntries);
  await db.delete(vibeMemories);
  await db.delete(syncStates);

  console.log("Starting full re-sync...");
  const summary = await syncAllAgentLogs();
  console.log(JSON.stringify(summary, null, 2));

  process.exit(0);
}

main();
