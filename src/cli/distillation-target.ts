import path from "node:path";
import { closeDbPool } from "../db/index.js";
import { refreshDistillationTargetInventory } from "../modules/selectDistillationTarget/inventory.service.js";
import type { DistillationTargetKind } from "../modules/selectDistillationTarget/domain.js";
import {
  DEFAULT_DISTILLATION_TARGET_VERSION,
  claimNextDistillationTargetState,
  finishDistillationTargetState,
  getDistillationTargetSummary,
  pauseDistillationTargetState,
  recoverStaleDistillationTargets,
  releaseRetryablePausedDistillationTargets,
  requeueDistillationTargetState,
  updateDistillationTargetHeartbeat,
  type DistillationTargetStateRow,
} from "../modules/selectDistillationTarget/repository.js";

type Command =
  | "status"
  | "refresh"
  | "claim"
  | "heartbeat"
  | "release-stale"
  | "release-paused"
  | "requeue"
  | "pause"
  | "mark-skipped";

type CliOptions = {
  command: Command;
  kind: "auto" | "wiki" | "vibe";
  rootPath?: string;
  vibeLimit: number;
  refresh: boolean;
  worker?: string;
  id?: string;
  reason?: string;
  distillationVersion: string;
  allowCompleted: boolean;
  staleSeconds?: number;
  maxAttempts?: number;
  retryDelaySeconds?: number;
};

const commands = new Set<Command>([
  "status",
  "refresh",
  "claim",
  "heartbeat",
  "release-stale",
  "release-paused",
  "requeue",
  "pause",
  "mark-skipped",
]);

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
  const first = args[0];
  const command = first && commands.has(first as Command) ? (first as Command) : "status";
  const offset = command === first ? 1 : 0;
  const options: CliOptions = {
    command,
    kind: "auto",
    vibeLimit: 100,
    refresh: command === "claim",
    distillationVersion: DEFAULT_DISTILLATION_TARGET_VERSION,
    allowCompleted: false,
  };

  for (let index = offset; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--kind" || arg.startsWith("--kind=")) {
      const value = readArgValue(args, index, "--kind").trim();
      if (arg === "--kind") index += 1;
      if (value !== "auto" && value !== "wiki" && value !== "vibe") {
        throw new Error("--kind must be auto, wiki, or vibe");
      }
      options.kind = value;
    } else if (arg === "--root" || arg.startsWith("--root=")) {
      const value = readArgValue(args, index, "--root").trim();
      if (arg === "--root") index += 1;
      if (!value) throw new Error("--root must not be empty");
      options.rootPath = path.resolve(value);
    } else if (arg === "--vibe-limit" || arg.startsWith("--vibe-limit=")) {
      options.vibeLimit = readPositiveInteger(args, index, "--vibe-limit");
      if (arg === "--vibe-limit") index += 1;
    } else if (arg === "--id" || arg.startsWith("--id=")) {
      options.id = readArgValue(args, index, "--id").trim();
      if (arg === "--id") index += 1;
    } else if (arg === "--worker" || arg.startsWith("--worker=")) {
      options.worker = readArgValue(args, index, "--worker").trim();
      if (arg === "--worker") index += 1;
    } else if (arg === "--reason" || arg.startsWith("--reason=")) {
      options.reason = readArgValue(args, index, "--reason").trim();
      if (arg === "--reason") index += 1;
    } else if (arg === "--version" || arg.startsWith("--version=")) {
      options.distillationVersion = readArgValue(args, index, "--version").trim();
      if (arg === "--version") index += 1;
    } else if (arg === "--stale-seconds" || arg.startsWith("--stale-seconds=")) {
      options.staleSeconds = readPositiveInteger(args, index, "--stale-seconds");
      if (arg === "--stale-seconds") index += 1;
    } else if (arg === "--max-attempts" || arg.startsWith("--max-attempts=")) {
      options.maxAttempts = readPositiveInteger(args, index, "--max-attempts");
      if (arg === "--max-attempts") index += 1;
    } else if (arg === "--retry-delay-seconds" || arg.startsWith("--retry-delay-seconds=")) {
      options.retryDelaySeconds = readPositiveInteger(args, index, "--retry-delay-seconds");
      if (arg === "--retry-delay-seconds") index += 1;
    } else if (arg === "--refresh") {
      options.refresh = true;
    } else if (arg === "--no-refresh") {
      options.refresh = false;
    } else if (arg === "--allow-completed") {
      options.allowCompleted = true;
    } else if (arg === "--json") {
      // JSON is the only output format.
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function requireId(options: CliOptions): string {
  if (!options.id) throw new Error(`${options.command} requires --id`);
  return options.id;
}

function compactTarget(row: DistillationTargetStateRow | null) {
  if (!row) return null;
  return {
    id: row.id,
    targetKind: row.targetKind,
    targetKey: row.targetKey,
    status: row.status,
  };
}

function compactSummaryTarget(row: DistillationTargetStateRow | null) {
  if (!row) return null;
  return {
    id: row.id,
    targetKind: row.targetKind,
    targetKey: row.targetKey,
    status: row.status,
    phase: row.phase,
    lastOutcomeKind: row.lastOutcomeKind,
    lastError: row.lastError,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function targetKindFilter(kind: CliOptions["kind"]): DistillationTargetKind | undefined {
  if (kind === "wiki") return "wiki_file";
  if (kind === "vibe") return "vibe_memory";
  return undefined;
}

async function maybeRefresh(options: CliOptions) {
  if (!options.refresh) return null;
  return refreshDistillationTargetInventory({
    kind: options.kind,
    rootPath: options.rootPath,
    vibeLimit: options.vibeLimit,
    distillationVersion: options.distillationVersion,
  });
}

async function run(options: CliOptions): Promise<unknown> {
  if (options.command === "refresh") {
    return refreshDistillationTargetInventory({
      kind: options.kind,
      rootPath: options.rootPath,
      vibeLimit: options.vibeLimit,
      distillationVersion: options.distillationVersion,
    });
  }

  if (options.command === "status") {
    await maybeRefresh(options);
    const summary = await getDistillationTargetSummary({
      distillationVersion: options.distillationVersion,
      staleSeconds: options.staleSeconds,
    });
    return {
      version: summary.version,
      mode: summary.mode,
      queued: summary.queued,
      pendingWiki: summary.pendingWiki,
      pendingVibeMemory: summary.pendingVibeMemory,
      running: summary.running,
      paused: summary.paused,
      staleRunning: summary.staleRunning,
      failed: summary.failed,
      skipped: summary.skipped,
      completed: summary.completed,
      lastCompleted: compactSummaryTarget(summary.lastCompleted),
      lastSkipped: compactSummaryTarget(summary.lastSkipped),
      lastFailed: compactSummaryTarget(summary.lastFailed),
    };
  }

  if (options.command === "claim") {
    await maybeRefresh(options);
    await recoverStaleDistillationTargets({
      distillationVersion: options.distillationVersion,
      staleSeconds: options.staleSeconds,
      maxAttempts: options.maxAttempts,
    });
    await releaseRetryablePausedDistillationTargets({
      distillationVersion: options.distillationVersion,
    });
    const claimed = await claimNextDistillationTargetState({
      distillationVersion: options.distillationVersion,
      targetKind: targetKindFilter(options.kind),
      worker: options.worker,
    });
    return compactTarget(claimed);
  }

  if (options.command === "heartbeat") {
    return compactTarget(await updateDistillationTargetHeartbeat(requireId(options)));
  }

  if (options.command === "release-stale") {
    return recoverStaleDistillationTargets({
      distillationVersion: options.distillationVersion,
      staleSeconds: options.staleSeconds,
      maxAttempts: options.maxAttempts,
    });
  }

  if (options.command === "release-paused") {
    return {
      released: await releaseRetryablePausedDistillationTargets({
        distillationVersion: options.distillationVersion,
      }),
    };
  }

  if (options.command === "requeue") {
    return compactTarget(
      await requeueDistillationTargetState({
        id: requireId(options),
        reason: options.reason,
        allowCompleted: options.allowCompleted,
      }),
    );
  }

  if (options.command === "pause") {
    return compactTarget(
      await pauseDistillationTargetState({
        id: requireId(options),
        reason: options.reason ?? "manual_pause",
        retryDelaySeconds: options.retryDelaySeconds,
      }),
    );
  }

  if (options.command === "mark-skipped") {
    return compactTarget(
      await finishDistillationTargetState({
        id: requireId(options),
        status: "skipped",
        outcomeKind: options.reason ?? "manual_skip",
        error: null,
      }),
    );
  }

  throw new Error(`Unsupported command: ${options.command}`);
}

async function main(): Promise<void> {
  const result = await run(parseArgs(process.argv.slice(2)));
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
