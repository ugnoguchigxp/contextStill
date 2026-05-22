import path from "node:path";
import { closeDbPool } from "../db/index.js";
import { previewNextDistillationTarget } from "../modules/selectDistillationTarget/inventory.service.js";

type CliOptions = {
  kind: "auto" | "wiki" | "vibe" | "candidate";
  rootPath?: string;
  vibeLimit?: number;
  fromStateTable: boolean;
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

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    kind: "auto",
    fromStateTable: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--kind" || arg.startsWith("--kind=")) {
      const value = readArgValue(args, index, "--kind").trim();
      if (arg === "--kind") index += 1;
      if (value !== "auto" && value !== "wiki" && value !== "vibe" && value !== "candidate") {
        throw new Error("--kind must be auto, wiki, vibe, or candidate");
      }
      options.kind = value;
    } else if (arg === "--root" || arg.startsWith("--root=")) {
      const value = readArgValue(args, index, "--root").trim();
      if (arg === "--root") index += 1;
      if (!value) throw new Error("--root must not be empty");
      options.rootPath = path.resolve(value);
    } else if (arg === "--vibe-limit" || arg.startsWith("--vibe-limit=")) {
      const value = readArgValue(args, index, "--vibe-limit");
      if (arg === "--vibe-limit") index += 1;
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error("--vibe-limit must be a positive integer");
      }
      options.vibeLimit = parsed;
    } else if (arg === "--json") {
      // JSON is the only output format.
    } else if (arg === "--from-state-table") {
      options.fromStateTable = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const selected = await previewNextDistillationTarget({
    kind: options.kind,
    rootPath: options.rootPath,
    vibeLimit: options.vibeLimit,
    fromStateTable: options.fromStateTable,
  });
  process.stdout.write(`${JSON.stringify(selected, null, 2)}\n`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbPool();
  });
