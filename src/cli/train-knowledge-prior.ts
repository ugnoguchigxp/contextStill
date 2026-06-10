import { resolve } from "node:path";
import { closeDbPool } from "../db/index.js";
import {
  DEFAULT_CONTEXT_DECISION_CORPUS_PRIOR_PATH,
  buildCorpusKnowledgePriorFromDb,
  writeCorpusKnowledgePrior,
} from "../modules/context-decision/context-decision.corpus-prior.js";

type CliOptions = {
  apply: boolean;
  outputPath: string;
  limit?: number;
};

function readArgValue(args: string[], index: number, name: string): string {
  const inline = args[index]?.match(new RegExp(`^${name}=(.*)$`))?.[1];
  if (inline !== undefined) return inline;
  const next = args[index + 1];
  if (!next || next.startsWith("--")) throw new Error(`${name} requires a value`);
  return next;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    apply: false,
    outputPath: DEFAULT_CONTEXT_DECISION_CORPUS_PRIOR_PATH,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--apply") {
      options.apply = true;
      continue;
    }
    if (arg === "--dry-run" || arg === "--json") {
      continue;
    }
    if (arg === "--output" || arg.startsWith("--output=")) {
      const raw = readArgValue(args, index, "--output");
      if (arg === "--output") index += 1;
      options.outputPath = resolve(raw);
      continue;
    }
    if (arg === "--limit" || arg.startsWith("--limit=")) {
      const raw = readArgValue(args, index, "--limit");
      if (arg === "--limit") index += 1;
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error("--limit must be a positive integer");
      }
      options.limit = parsed;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const prior = await buildCorpusKnowledgePriorFromDb({ limit: options.limit });
  let writtenPath: string | null = null;
  if (options.apply) {
    writtenPath = await writeCorpusKnowledgePrior(prior, options.outputPath);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        dryRun: !options.apply,
        outputPath: options.outputPath,
        writtenPath,
        prior,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbPool();
  });
