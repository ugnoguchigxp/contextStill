import { groupedConfig } from "../config.js";
import { closeDbPool } from "../db/index.js";
import {
  type DistillationQueueName,
  distillationQueueNames,
  runQueueWorkerOnce,
} from "../modules/queue/core/index.js";
import {
  ensureRuntimeSettingsLoaded,
  reloadRuntimeSettingsCache,
} from "../modules/settings/settings.service.js";

type CliOptions = {
  continuous: boolean;
  limit: number;
  worker: string;
  queueNames: DistillationQueueName[];
};

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    continuous: false,
    limit: 1,
    worker: "queue-supervisor",
    queueNames: [...distillationQueueNames],
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--continuous") {
      options.continuous = true;
    } else if (arg === "--once") {
      options.continuous = false;
    } else if (arg === "--worker" || arg.startsWith("--worker=")) {
      const inline = arg.match(/^--worker=(.*)$/)?.[1];
      if (inline !== undefined) {
        const worker = inline.trim();
        if (worker) options.worker = worker;
      } else {
        const next = args[index + 1];
        if (!next || next.startsWith("--")) throw new Error("--worker requires a value");
        const worker = next.trim();
        if (worker) options.worker = worker;
        index += 1;
      }
    } else if (arg === "--queue" || arg.startsWith("--queue=")) {
      const inline = arg.match(/^--queue=(.*)$/)?.[1];
      const raw =
        inline !== undefined
          ? inline
          : (() => {
              const next = args[index + 1];
              if (!next || next.startsWith("--")) throw new Error("--queue requires a value");
              index += 1;
              return next;
            })();
      const queue = raw.trim() as DistillationQueueName;
      if (!distillationQueueNames.includes(queue)) {
        throw new Error(`--queue must be one of: ${distillationQueueNames.join(", ")}`);
      }
      options.queueNames = [queue];
    } else if (arg === "--limit" || arg.startsWith("--limit=")) {
      const inline = arg.match(/^--limit=(.*)$/)?.[1];
      const raw =
        inline !== undefined
          ? inline
          : (() => {
              const next = args[index + 1];
              if (!next || next.startsWith("--")) throw new Error("--limit requires a value");
              index += 1;
              return next;
            })();
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed !== 1) {
        throw new Error("--limit must be 1 (one worker per queue)");
      }
      options.limit = parsed;
    } else if (arg === "--json") {
      // json-only output
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const runtimeSettingsRefreshIntervalMs = 5_000;
let nextRuntimeSettingsRefreshAt = 0;
let runtimeSettingsRefreshPromise: Promise<void> | null = null;

async function refreshRuntimeSettings(force = false): Promise<void> {
  const now = Date.now();
  if (!force && now < nextRuntimeSettingsRefreshAt) return;
  if (runtimeSettingsRefreshPromise) {
    await runtimeSettingsRefreshPromise;
    return;
  }

  runtimeSettingsRefreshPromise = reloadRuntimeSettingsCache().finally(() => {
    nextRuntimeSettingsRefreshAt = Date.now() + runtimeSettingsRefreshIntervalMs;
    runtimeSettingsRefreshPromise = null;
  });
  await runtimeSettingsRefreshPromise;
}

function queueTaskDelayMs(queueName: DistillationQueueName, idle: boolean): number {
  if (idle) return groupedConfig.distillation.continuousIdleSleepMs;
  if (queueName === "findingCandidate") {
    return groupedConfig.distillation.findingQueueTaskIntervalSeconds * 1000;
  }
  if (queueName === "coveringEvidence") {
    return groupedConfig.distillation.coveringQueueTaskIntervalSeconds * 1000;
  }
  return 0;
}

async function sleepForQueueDelay(queueName: DistillationQueueName, idle: boolean): Promise<void> {
  const start = Date.now();
  while (!stopping) {
    await refreshRuntimeSettings();
    const sleepMs = queueTaskDelayMs(queueName, idle);
    const elapsed = Date.now() - start;
    if (elapsed >= sleepMs) return;
    await sleep(Math.max(1, Math.min(100, sleepMs - elapsed)));
  }
}

async function runOnce(options: CliOptions) {
  const runTasks = options.queueNames.flatMap((queueName) =>
    Array.from({ length: options.limit }, (_, index) =>
      runQueueWorkerOnce({
        queueName,
        workerId: `${options.worker}:${queueName}:${index + 1}`,
      }),
    ),
  );
  const runs = await Promise.all(runTasks);
  const processed = runs.filter((run) => !run.idle).length;
  const failed = runs.filter((run) => !run.ok).length;
  const result = {
    ok: failed === 0,
    limit: options.limit,
    worker: options.worker,
    processed,
    failed,
    idle: processed === 0,
    runs,
  } as const;
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

let stopping = false;
let activeLoopsPromise: Promise<unknown[]> | null = null;

async function runContinuous(options: CliOptions): Promise<void> {
  await refreshRuntimeSettings(true);
  const runLoop = async (queueName: DistillationQueueName): Promise<void> => {
    let wasIdle = false;
    while (!stopping) {
      try {
        const run = await runQueueWorkerOnce({
          queueName,
          workerId: `${options.worker}:${queueName}:1`,
        });
        if (!run.idle || !wasIdle || !run.ok) {
          process.stdout.write(
            `${JSON.stringify(
              {
                mode: "continuous",
                queue: queueName,
                run,
              },
              null,
              2,
            )}\n`,
          );
        }
        wasIdle = run.idle;
        await sleepForQueueDelay(queueName, run.idle);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        const start = Date.now();
        const errSleep = groupedConfig.distillation.continuousErrorSleepMs;
        while (Date.now() - start < errSleep && !stopping) {
          await sleep(Math.max(1, Math.min(100, errSleep - (Date.now() - start))));
        }
      }
    }
  };

  activeLoopsPromise = Promise.all(options.queueNames.map((queueName) => runLoop(queueName)));
  await activeLoopsPromise;
}

let shuttingDown = false;

const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`\nReceived ${signal} in queue supervisor. Shutting down gracefully...`);
  stopping = true;

  const forceExitTimer = setTimeout(() => {
    console.error("Queue supervisor graceful shutdown timed out. Forcing exit.");
    process.exit(1);
  }, 15_000);

  try {
    if (activeLoopsPromise) {
      console.log("Waiting for active queue worker loops to yield...");
      await activeLoopsPromise;
    }

    console.log("Closing queue supervisor database connection pool...");
    await closeDbPool();
    console.log("Queue supervisor shutdown complete.");
    clearTimeout(forceExitTimer);
    process.exit(0);
  } catch (error) {
    clearTimeout(forceExitTimer);
    console.error("Error during queue supervisor shutdown:", error);
    process.exit(1);
  }
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.continuous) {
    await runContinuous(options);
    return;
  }
  await ensureRuntimeSettingsLoaded();
  await runOnce(options);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    // Only close pool here if we are running in once mode, as continuous mode handles it in shutdown()
    const options = parseArgs(process.argv.slice(2));
    if (!options.continuous) {
      await closeDbPool();
    }
  });
