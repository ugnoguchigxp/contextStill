import { closeDbPool } from "../db/index.js";
import { requeueEpisodeDistillerRepairCandidates } from "../modules/episodeDistiller/repository.js";

type CliOptions = {
  write: boolean;
  limit: number;
  reason?: string;
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

export function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    write: false,
    limit: 100,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--write") {
      options.write = true;
    } else if (arg === "--dry-run") {
      options.write = false;
    } else if (arg === "--limit" || arg.startsWith("--limit=")) {
      const raw = readArgValue(args, index, "--limit");
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error("--limit must be a positive integer");
      }
      options.limit = parsed;
      if (arg === "--limit") index += 1;
    } else if (arg === "--reason" || arg.startsWith("--reason=")) {
      options.reason = readArgValue(args, index, "--reason").trim();
      if (arg === "--reason") index += 1;
    } else if (arg === "--json") {
      // JSON is the only output format.
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const result = await requeueEpisodeDistillerRepairCandidates(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbPool();
  });
