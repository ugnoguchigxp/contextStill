import { closeDbPool } from "../db/index.js";
import { knowledgeTagDefinitionSeeds } from "../knowledge/tagDefinitionSeeds.js";
import { upsertKnowledgeTagDefinitions } from "../modules/knowledge/knowledge-tags.repository.js";

function parseArgs(args: string[]): { apply: boolean } {
  let apply = false;
  for (const arg of args) {
    if (arg === "--apply") apply = true;
    else if (arg === "--dry-run" || arg === "--json") apply = false;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { apply };
}

async function main(): Promise<void> {
  const { apply } = parseArgs(process.argv.slice(2));
  const plannedCount = knowledgeTagDefinitionSeeds.length;

  if (!apply) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          dryRun: true,
          plannedCount,
          nextCommand: "bun run seed:knowledge-tags --apply",
        },
        null,
        2,
      ),
    );
    return;
  }

  const changedCount = await upsertKnowledgeTagDefinitions(knowledgeTagDefinitionSeeds);
  console.log(
    JSON.stringify(
      {
        ok: true,
        dryRun: false,
        plannedCount,
        changedCount,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbPool();
  });
