import { closeDbPool } from "../db/index.js";
import {
  generateUtilityRetrievalReport,
  type UtilityRetrievalReportMode,
} from "../modules/context-compiler/utility-retrieval.service.js";

type CliOptions = {
  mode: UtilityRetrievalReportMode;
  sinceDays: number;
  limit: number;
  json: boolean;
};

function readArgValue(args: string[], index: number, name: string): string {
  const inline = args[index]?.match(new RegExp(`^${name}=(.*)$`))?.[1];
  if (inline !== undefined) return inline;
  const next = args[index + 1];
  if (!next || next.startsWith("--")) throw new Error(`${name} requires a value`);
  return next;
}

function parsePositiveInt(raw: string, name: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseMode(raw: string): UtilityRetrievalReportMode {
  if (raw === "baseline" || raw === "observation" || raw === "promotion-dry-run") {
    return raw;
  }
  throw new Error("--mode must be baseline, observation, or promotion-dry-run");
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    mode: "baseline",
    sinceDays: 14,
    limit: 200,
    json: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--mode" || arg.startsWith("--mode=")) {
      const raw = readArgValue(args, index, "--mode");
      if (arg === "--mode") index += 1;
      options.mode = parseMode(raw);
      continue;
    }
    if (arg === "--since-days" || arg.startsWith("--since-days=")) {
      const raw = readArgValue(args, index, "--since-days");
      if (arg === "--since-days") index += 1;
      options.sinceDays = parsePositiveInt(raw, "--since-days");
      continue;
    }
    if (arg === "--limit" || arg.startsWith("--limit=")) {
      const raw = readArgValue(args, index, "--limit");
      if (arg === "--limit") index += 1;
      options.limit = parsePositiveInt(raw, "--limit");
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const report = await generateUtilityRetrievalReport(options);
  if (!options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(JSON.stringify(report));
}

main()
  .catch((error) => {
    console.error("[utility-retrieval-report] failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbPool();
  });
