import path from "node:path";
import { groupedConfig } from "../config.js";
import { closeDbPool } from "../db/index.js";
import {
  runDistillationPipeline,
  type DistillationPipelineInput,
} from "../modules/distillationPipeline/runner.js";
import { acquireFileLock, type FileLockHandle } from "./file-lock.js";

type CliOptions = {
  kind: "auto" | "wiki" | "vibe";
  limit: number;
  write: boolean;
  refresh: boolean;
  rootPath?: string;
  vibeLimit?: number;
  worker?: string;
  provider?: DistillationPipelineInput["provider"];
  distillationVersion?: string;
  forceRefreshEvidence: boolean;
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
    limit: 1,
    write: false,
    refresh: true,
    forceRefreshEvidence: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--kind" || arg.startsWith("--kind=")) {
      const value = readArgValue(args, index, "--kind").trim();
      if (arg === "--kind") index += 1;
      if (value !== "auto" && value !== "wiki" && value !== "vibe") {
        throw new Error("--kind must be auto, wiki, or vibe");
      }
      options.kind = value;
    } else if (arg === "--limit" || arg.startsWith("--limit=")) {
      options.limit = readPositiveInteger(args, index, "--limit");
      if (arg === "--limit") index += 1;
    } else if (arg === "--vibe-limit" || arg.startsWith("--vibe-limit=")) {
      options.vibeLimit = readPositiveInteger(args, index, "--vibe-limit");
      if (arg === "--vibe-limit") index += 1;
    } else if (arg === "--root" || arg.startsWith("--root=")) {
      const value = readArgValue(args, index, "--root").trim();
      if (arg === "--root") index += 1;
      if (!value) throw new Error("--root must not be empty");
      options.rootPath = path.resolve(value);
    } else if (arg === "--worker" || arg.startsWith("--worker=")) {
      options.worker = readArgValue(args, index, "--worker").trim();
      if (arg === "--worker") index += 1;
    } else if (arg === "--version" || arg.startsWith("--version=")) {
      options.distillationVersion = readArgValue(args, index, "--version").trim();
      if (arg === "--version") index += 1;
    } else if (arg === "--provider" || arg.startsWith("--provider=")) {
      const value = readArgValue(args, index, "--provider").trim();
      if (arg === "--provider") index += 1;
      if (
        value !== "local-llm" &&
        value !== "azure-openai" &&
        value !== "bedrock" &&
        value !== "auto"
      ) {
        throw new Error("--provider must be local-llm, azure-openai, bedrock, or auto");
      }
      options.provider = value;
    } else if (arg === "--write") {
      options.write = true;
    } else if (arg === "--refresh") {
      options.refresh = true;
    } else if (arg === "--no-refresh") {
      options.refresh = false;
    } else if (arg === "--force-refresh-evidence") {
      options.forceRefreshEvidence = true;
    } else if (arg === "--json") {
      // JSON is the only output format.
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.write) {
    throw new Error("--write is required");
  }

  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  let lock: FileLockHandle | null = null;
  try {
    lock = await acquireFileLock({
      lockFile: path.resolve(process.cwd(), "logs", "distillation-pipeline.lock"),
      ttlSeconds: groupedConfig.distillation.lockTtlSeconds,
      label: "distillation pipeline",
      wait: true,
    });
    const result = await runDistillationPipeline({
      kind: options.kind,
      limit: options.limit,
      worker: options.worker,
      provider: options.provider,
      distillationVersion: options.distillationVersion,
      refresh: options.refresh,
      rootPath: options.rootPath,
      vibeLimit: options.vibeLimit,
      forceRefreshEvidence: options.forceRefreshEvidence,
      write: true,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await lock?.release();
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbPool();
  });
