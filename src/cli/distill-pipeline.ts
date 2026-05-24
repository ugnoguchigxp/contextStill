import path from "node:path";
import { groupedConfig } from "../config.js";
import { closeDbPool } from "../db/index.js";
import {
  type DistillationPipelineInput,
  runDistillationPipeline,
} from "../modules/distillationPipeline/runner.js";
import { type FileLockHandle, acquireFileLock } from "./file-lock.js";

type CliOptions = {
  kind: "auto" | "wiki" | "vibe" | "candidate";
  limit: number;
  targetStateId?: string;
  write: boolean;
  refresh: boolean;
  continuous: boolean;
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
    continuous: false,
    forceRefreshEvidence: false,
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
    } else if (arg === "--target-state-id" || arg.startsWith("--target-state-id=")) {
      const value = readArgValue(args, index, "--target-state-id").trim();
      if (arg === "--target-state-id") index += 1;
      if (!value) throw new Error("--target-state-id must not be empty");
      options.targetStateId = value;
    } else if (arg === "--provider" || arg.startsWith("--provider=")) {
      const value = readArgValue(args, index, "--provider").trim();
      if (arg === "--provider") index += 1;
      if (
        value !== "openai" &&
        value !== "local-llm" &&
        value !== "azure-openai" &&
        value !== "bedrock" &&
        value !== "auto"
      ) {
        throw new Error("--provider must be openai, local-llm, azure-openai, bedrock, or auto");
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
    } else if (arg === "--continuous") {
      options.continuous = true;
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

function lockFilePath(): string {
  return groupedConfig.distillation.pipelineLockFile;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pipelineInput(
  options: CliOptions,
  refresh: boolean,
  limit: number,
): DistillationPipelineInput {
  return {
    kind: options.kind,
    limit,
    targetStateId: options.targetStateId,
    worker: options.worker,
    provider: options.provider,
    distillationVersion: options.distillationVersion,
    refresh,
    rootPath: options.rootPath,
    vibeLimit: options.vibeLimit,
    forceRefreshEvidence: options.forceRefreshEvidence,
    write: true,
  };
}

async function runOnceWithLock(
  options: CliOptions,
  params: { refresh: boolean; limit: number; wait: boolean },
): Promise<Awaited<ReturnType<typeof runDistillationPipeline>>> {
  let lock: FileLockHandle | null = null;
  try {
    lock = await acquireFileLock({
      lockFile: lockFilePath(),
      ttlSeconds: groupedConfig.distillation.lockTtlSeconds,
      staleCreatedAgeSeconds: groupedConfig.distillation.pipelineLockStaleSeconds,
      removeWhenCreatedAgeExceeded: true,
      label: "distillation pipeline",
      wait: params.wait,
    });
    return await runDistillationPipeline(pipelineInput(options, params.refresh, params.limit));
  } finally {
    await lock?.release();
  }
}

async function runContinuous(options: CliOptions): Promise<void> {
  let lastRefreshAt = 0;
  while (true) {
    try {
      const now = Date.now();
      const refresh =
        options.refresh &&
        (lastRefreshAt === 0 ||
          now - lastRefreshAt >= groupedConfig.distillation.inventoryRefreshIntervalMs);
      if (refresh) lastRefreshAt = now;
      const result = await runOnceWithLock(options, {
        refresh,
        limit: 1,
        wait: false,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (result.idle) {
        await sleep(groupedConfig.distillation.continuousIdleSleepMs);
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      await sleep(groupedConfig.distillation.continuousErrorSleepMs);
    }
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.continuous) {
    await runContinuous(options);
    return;
  }

  const result = await runOnceWithLock(options, {
    refresh: options.refresh,
    limit: options.limit,
    wait: true,
  });
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
