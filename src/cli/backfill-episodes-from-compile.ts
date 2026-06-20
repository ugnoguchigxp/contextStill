import { closeDbPool } from "../db/index.js";
import { backfillEpisodeFromCompileRun } from "../modules/episodic-memory/episode-card.service.js";

type CliOptions = {
  runIds: string[];
  write: boolean;
};

function readArgValue(args: string[], index: number, name: string): string {
  const inline = args[index]?.match(new RegExp(`^${name}=(.*)$`))?.[1];
  if (inline !== undefined) return inline;
  const next = args[index + 1];
  if (!next || next.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return next;
}

function parseCsv(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseArgs(args: string[]): CliOptions {
  const runIds: string[] = [];
  let write = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--run-id" || arg.startsWith("--run-id=")) {
      runIds.push(...parseCsv(readArgValue(args, index, "--run-id")));
      if (arg === "--run-id") index += 1;
    } else if (arg === "--run-ids" || arg.startsWith("--run-ids=")) {
      runIds.push(...parseCsv(readArgValue(args, index, "--run-ids")));
      if (arg === "--run-ids") index += 1;
    } else if (arg === "--write") {
      write = true;
    } else if (arg === "--dry-run") {
      write = false;
    } else if (arg === "--json") {
      // JSON is the only output format.
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  const uniqueRunIds = [...new Set(runIds)];
  if (uniqueRunIds.length === 0) {
    throw new Error("--run-id is required");
  }
  return { runIds: uniqueRunIds, write };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const results = [];
  for (const runId of options.runIds) {
    results.push(await backfillEpisodeFromCompileRun({ runId, write: options.write }));
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        write: options.write,
        count: results.length,
        createdCount: results.filter((item) => item.status === "created").length,
        skippedExistingCount: results.filter((item) => item.status === "skipped_existing").length,
        notFoundCount: results.filter((item) => item.status === "not_found").length,
        results,
      },
      null,
      2,
    )}\n`,
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
