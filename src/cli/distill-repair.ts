import { closeDbPool } from "../db/index.js";
import {
  type DistillationRepairInput,
  runDistillationRepair,
} from "../modules/distillationTarget/repair.service.js";

type CliOptions = DistillationRepairInput;

function readArgValue(args: string[], index: number, name: string): string {
  const inline = args[index]?.match(new RegExp(`^${name}=(.*)$`))?.[1];
  if (inline !== undefined) return inline;
  const next = args[index + 1];
  if (!next || next.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return next;
}

function readPositiveInteger(args: string[], index: number, name: string): number {
  const value = readArgValue(args, index, name);
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    kind: "auto",
    apply: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--kind" || arg.startsWith("--kind=")) {
      const value = readArgValue(args, index, "--kind").trim();
      if (arg === "--kind") index += 1;
      if (
        value !== "auto" &&
        value !== "wiki" &&
        value !== "vibe" &&
        value !== "candidate" &&
        value !== "web"
      ) {
        throw new Error("--kind must be auto, wiki, vibe, candidate, or web");
      }
      options.kind = value;
    } else if (arg === "--version" || arg.startsWith("--version=")) {
      options.distillationVersion = readArgValue(args, index, "--version").trim();
      if (arg === "--version") index += 1;
      if (!options.distillationVersion) {
        throw new Error("--version must not be empty");
      }
    } else if (arg === "--limit" || arg.startsWith("--limit=")) {
      options.limit = readPositiveInteger(args, index, "--limit");
      if (arg === "--limit") index += 1;
    } else if (arg === "--stale-seconds" || arg.startsWith("--stale-seconds=")) {
      options.staleSeconds = readPositiveInteger(args, index, "--stale-seconds");
      if (arg === "--stale-seconds") index += 1;
    } else if (arg === "--max-attempts" || arg.startsWith("--max-attempts=")) {
      options.maxAttempts = readPositiveInteger(args, index, "--max-attempts");
      if (arg === "--max-attempts") index += 1;
    } else if (arg === "--apply") {
      options.apply = true;
    } else if (arg === "--json") {
      // JSON is the only output format.
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

async function main(): Promise<void> {
  const report = await runDistillationRepair(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbPool();
  });
