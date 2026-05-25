import { groupedConfig } from "../config.js";
import { closeDbPool } from "../db/index.js";
import {
  distillationQueueNames,
  runQueueWorkerOnce,
  type DistillationQueueName,
} from "../modules/queue/core/index.js";

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

async function runContinuous(options: CliOptions): Promise<void> {
  const busySleepMs = 0;
  const findingQueueTaskIntervalMs =
    groupedConfig.distillation.findingQueueTaskIntervalSeconds * 1000;
  const runLoop = async (queueName: DistillationQueueName): Promise<void> => {
    let wasIdle = false;
    while (true) {
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
        const sleepMs = run.idle
          ? groupedConfig.distillation.continuousIdleSleepMs
          : queueName === "findingCandidate"
            ? findingQueueTaskIntervalMs
            : busySleepMs;
        await sleep(sleepMs);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        await sleep(groupedConfig.distillation.continuousErrorSleepMs);
      }
    }
  };

  await Promise.all(options.queueNames.map((queueName) => runLoop(queueName)));
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.continuous) {
    await runContinuous(options);
    return;
  }
  await runOnce(options);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbPool();
  });
