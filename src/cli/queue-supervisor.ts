import { groupedConfig } from "../config.js";
import { closeDbPool } from "../db/index.js";
import {
  claimNextJobWithProviderLease,
  countAvailableProviderPoolSlots,
  type DistillationQueueName,
  distillationQueueNames,
  enabledProviderPoolsForQueues,
  priorityQueuesForProviderPool,
  runQueueWorkerOnce,
  unpooledQueues,
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

function appendQueueNames(
  queueNames: DistillationQueueName[],
  raw: string,
): DistillationQueueName[] {
  const requested = raw
    .split(",")
    .map((queueName) => queueName.trim())
    .filter(Boolean);
  if (requested.length === 0) {
    throw new Error("--queue requires a value");
  }

  const nextQueueNames = [...queueNames];
  for (const queueName of requested) {
    if (!distillationQueueNames.includes(queueName as DistillationQueueName)) {
      throw new Error(`--queue must be one of: ${distillationQueueNames.join(", ")}`);
    }
    const typedQueueName = queueName as DistillationQueueName;
    if (!nextQueueNames.includes(typedQueueName)) {
      nextQueueNames.push(typedQueueName);
    }
  }
  return nextQueueNames;
}

export function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    continuous: false,
    limit: 1,
    worker: "queue-supervisor",
    queueNames: [],
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
      options.queueNames = appendQueueNames(options.queueNames, raw);
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

  return {
    ...options,
    queueNames: options.queueNames.length > 0 ? options.queueNames : [...distillationQueueNames],
  };
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

async function runOnce(options: CliOptions) {
  await refreshRuntimeSettings(true);
  const runTasks: Array<ReturnType<typeof runQueueWorkerOnce>> = [];
  for (const pool of enabledProviderPoolsForQueues(options.queueNames)) {
    const freeSlots = await countAvailableProviderPoolSlots(pool);
    for (let index = 0; index < freeSlots; index += 1) {
      const assignment = await claimNextJobWithProviderLease({
        pool,
        priorityQueues: priorityQueuesForProviderPool({
          poolId: pool.id,
          allowedQueues: options.queueNames,
        }),
        workerId: `${options.worker}:${pool.id}:${index + 1}`,
      });
      if (!assignment) break;
      runTasks.push(
        runQueueWorkerOnce({
          queueName: assignment.queueName,
          workerId: `${options.worker}:${pool.id}:${index + 1}`,
          claimedJob: { id: assignment.id },
          providerLease: assignment.providerLease,
        }),
      );
    }
  }
  runTasks.push(
    ...unpooledQueues(options.queueNames).flatMap((queueName) =>
      Array.from({ length: options.limit }, (_, index) =>
        runQueueWorkerOnce({
          queueName,
          workerId: `${options.worker}:${queueName}:${index + 1}`,
        }),
      ),
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
let schedulerWakeup = false;

function triggerSchedulerWakeup(): void {
  schedulerWakeup = true;
}

async function schedulerSleep(ms: number): Promise<void> {
  const startedAt = Date.now();
  while (!stopping && !schedulerWakeup && Date.now() - startedAt < ms) {
    await sleep(Math.max(1, Math.min(100, ms - (Date.now() - startedAt))));
  }
  schedulerWakeup = false;
}

async function runContinuous(options: CliOptions): Promise<void> {
  await refreshRuntimeSettings(true);
  const activeTasks = new Set<Promise<void>>();
  const runLoop = async (): Promise<void> => {
    const lastIdleByQueue = new Map<DistillationQueueName, boolean>();
    while (!stopping) {
      try {
        await refreshRuntimeSettings();
        let assigned = 0;
        for (const pool of enabledProviderPoolsForQueues(options.queueNames)) {
          const priorityQueues = priorityQueuesForProviderPool({
            poolId: pool.id,
            allowedQueues: options.queueNames,
          });
          let freeSlots = await countAvailableProviderPoolSlots(pool);
          while (freeSlots > 0 && !stopping) {
            const assignment = await claimNextJobWithProviderLease({
              pool,
              priorityQueues,
              workerId: `${options.worker}:${pool.id}:${Date.now()}:${assigned + 1}`,
            });
            if (!assignment) break;
            assigned += 1;
            freeSlots -= 1;
            const task = runQueueWorkerOnce({
              queueName: assignment.queueName,
              workerId: assignment.providerLease.workerId,
              claimedJob: { id: assignment.id },
              providerLease: assignment.providerLease,
            })
              .then((run) => {
                process.stdout.write(
                  `${JSON.stringify(
                    {
                      mode: "continuous",
                      queue: assignment.queueName,
                      providerPoolId: pool.id,
                      providerTargetId: assignment.providerLease.targetId,
                      run,
                    },
                    null,
                    2,
                  )}\n`,
                );
              })
              .catch((error) => {
                console.error(error instanceof Error ? error.message : String(error));
              })
              .finally(() => {
                activeTasks.delete(task);
                triggerSchedulerWakeup();
              });
            activeTasks.add(task);
          }
        }
        for (const queueName of unpooledQueues(options.queueNames)) {
          const run = await runQueueWorkerOnce({
            queueName,
            workerId: `${options.worker}:${queueName}:1`,
          });
          const wasIdle = lastIdleByQueue.get(queueName) ?? false;
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
          lastIdleByQueue.set(queueName, run.idle);
        }
        await schedulerSleep(
          assigned > 0
            ? Math.min(100, groupedConfig.distillation.continuousIdleSleepMs)
            : groupedConfig.distillation.continuousIdleSleepMs,
        );
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        const start = Date.now();
        const errSleep = groupedConfig.distillation.continuousErrorSleepMs;
        while (Date.now() - start < errSleep && !stopping) {
          await sleep(Math.max(1, Math.min(100, errSleep - (Date.now() - start))));
        }
      }
    }
    if (activeTasks.size > 0) {
      await Promise.allSettled([...activeTasks]);
    }
  };

  activeLoopsPromise = Promise.all([runLoop()]);
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

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.continuous) {
    await runContinuous(options);
    return;
  }
  await ensureRuntimeSettingsLoaded();
  await runOnce(options);
}

if (import.meta.main) {
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

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
}
