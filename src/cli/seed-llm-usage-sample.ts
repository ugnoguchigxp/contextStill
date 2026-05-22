import type { InferInsertModel } from "drizzle-orm";
import { like } from "drizzle-orm";
import { closeDbPool, db } from "../db/index.js";
import { llmUsageLogs } from "../db/schema.js";
import { calculateCost } from "../modules/llm/llm-cost-config.js";

type CliOptions = {
  days: number;
  reset: boolean;
};

type LlmUsageLogInsert = InferInsertModel<typeof llmUsageLogs>;

function readArgValue(args: string[], index: number, name: string): string {
  const inline = args[index]?.match(new RegExp(`^${name}=(.*)$`))?.[1];
  if (inline !== undefined) return inline;
  const next = args[index + 1];
  if (!next || next.startsWith("--")) throw new Error(`${name} requires a value`);
  return next;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { days: 14, reset: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--reset") {
      options.reset = true;
      continue;
    }
    if (arg === "--days" || arg.startsWith("--days=")) {
      const raw = readArgValue(args, index, "--days");
      if (arg === "--days") index += 1;
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 90) {
        throw new Error("--days must be an integer between 1 and 90");
      }
      options.days = parsed;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function sampleCreatedAt(daysAgo: number): Date {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() - daysAgo);
  return date;
}

function buildUsageRow(params: {
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens?: number;
  usageMode?: "measured" | "estimated";
  source: string;
  createdAt: Date;
}): LlmUsageLogInsert {
  const reasoningTokens = params.reasoningTokens ?? 0;
  return {
    provider: params.provider,
    model: params.model,
    promptTokens: params.promptTokens,
    completionTokens: params.completionTokens,
    totalTokens: params.promptTokens + params.completionTokens,
    reasoningTokens,
    costJpy:
      params.provider === "local-llm"
        ? 0
        : calculateCost(params.model, params.promptTokens, params.completionTokens),
    usageMode: params.usageMode ?? "measured",
    source: params.source,
    createdAt: params.createdAt,
  };
}

function buildSampleRows(days: number): LlmUsageLogInsert[] {
  const rows: LlmUsageLogInsert[] = [];
  for (let daysAgo = days - 1; daysAgo >= 0; daysAgo -= 1) {
    const sequence = days - daysAgo;
    const createdAt = sampleCreatedAt(daysAgo);
    rows.push(
      buildUsageRow({
        provider: "local-llm",
        model: "gemma-4-e4b-it",
        promptTokens: 1600 + sequence * 120,
        completionTokens: 520 + sequence * 40,
        usageMode: sequence % 4 === 0 ? "estimated" : "measured",
        source: "sample:local",
        createdAt,
      }),
      buildUsageRow({
        provider: "azure-openai",
        model: sequence % 2 === 0 ? "o3-mini" : "gpt-4o",
        promptTokens: 900 + sequence * 75,
        completionTokens: 300 + sequence * 30,
        reasoningTokens: sequence % 2 === 0 ? 80 + sequence * 5 : 0,
        source: "sample:cloud",
        createdAt,
      }),
    );
    if (sequence % 3 === 0) {
      rows.push(
        buildUsageRow({
          provider: "bedrock",
          model: "claude-3-5-sonnet",
          promptTokens: 700 + sequence * 55,
          completionTokens: 260 + sequence * 25,
          source: "sample:cloud",
          createdAt,
        }),
      );
    }
  }
  return rows;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.reset) {
    await db.delete(llmUsageLogs).where(like(llmUsageLogs.source, "sample:%"));
  }

  const rows = buildSampleRows(options.days);
  if (rows.length === 0) {
    console.log("no sample rows to insert");
    return;
  }

  await db.insert(llmUsageLogs).values(rows);
  console.log(`inserted ${rows.length} llm usage sample rows for ${options.days} days`);
}

main()
  .catch((error) => {
    console.error("[seed-llm-usage-sample] failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbPool();
  });
