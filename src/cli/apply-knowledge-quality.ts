import { closeDbPool } from "../db/index.js";
import { applyKnowledgeQualityAdjustments } from "../modules/knowledge/knowledge-quality.service.js";

type CliOptions = {
  apply: boolean;
  limit?: number;
  windowDays?: number;
  cooldownDays?: number;
  minOffTopicRuns?: number;
  minOffTopicRate?: number;
  decrement?: number;
};

function readArgValue(args: string[], index: number, name: string): string {
  const inline = args[index]?.match(new RegExp(`^${name}=(.*)$`))?.[1];
  if (inline !== undefined) return inline;
  const next = args[index + 1];
  if (!next || next.startsWith("--")) throw new Error(`${name} requires a value`);
  return next;
}

function parseIntegerFlag(
  args: string[],
  index: number,
  name: string,
): { value: number; consumedNext: boolean } {
  const raw = readArgValue(args, index, name);
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return { value: parsed, consumedNext: args[index] === name };
}

function parseFloatFlag(
  args: string[],
  index: number,
  name: string,
): { value: number; consumedNext: boolean } {
  const raw = readArgValue(args, index, name);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${name} must be between 0 and 1`);
  }
  return { value: parsed, consumedNext: args[index] === name };
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { apply: false };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--apply") {
      options.apply = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.apply = false;
      continue;
    }
    if (arg === "--json") continue;

    if (arg === "--limit" || arg.startsWith("--limit=")) {
      const parsed = parseIntegerFlag(args, index, "--limit");
      options.limit = parsed.value;
      if (parsed.consumedNext) index += 1;
      continue;
    }
    if (arg === "--window-days" || arg.startsWith("--window-days=")) {
      const parsed = parseIntegerFlag(args, index, "--window-days");
      options.windowDays = parsed.value;
      if (parsed.consumedNext) index += 1;
      continue;
    }
    if (arg === "--cooldown-days" || arg.startsWith("--cooldown-days=")) {
      const parsed = parseIntegerFlag(args, index, "--cooldown-days");
      options.cooldownDays = parsed.value;
      if (parsed.consumedNext) index += 1;
      continue;
    }
    if (arg === "--min-off-topic-runs" || arg.startsWith("--min-off-topic-runs=")) {
      const parsed = parseIntegerFlag(args, index, "--min-off-topic-runs");
      options.minOffTopicRuns = parsed.value;
      if (parsed.consumedNext) index += 1;
      continue;
    }
    if (arg === "--decrement" || arg.startsWith("--decrement=")) {
      const parsed = parseIntegerFlag(args, index, "--decrement");
      options.decrement = parsed.value;
      if (parsed.consumedNext) index += 1;
      continue;
    }
    if (arg === "--min-off-topic-rate" || arg.startsWith("--min-off-topic-rate=")) {
      const parsed = parseFloatFlag(args, index, "--min-off-topic-rate");
      options.minOffTopicRate = parsed.value;
      if (parsed.consumedNext) index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const result = await applyKnowledgeQualityAdjustments(options);
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbPool();
  });
