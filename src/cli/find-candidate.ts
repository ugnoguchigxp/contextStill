import { closeDbPool } from "../db/index.js";
import {
  type FindCandidateCallerMode,
  type FindCandidateInput,
  formatCliTextCandidates,
  runFindCandidate,
} from "../modules/findCandidate/domain.js";

type CliOptions = {
  targetStateId: string;
  provider?: FindCandidateInput["provider"];
  callerMode: FindCandidateCallerMode;
  fromToken?: number;
  readTokens?: number;
  maxReads?: number;
  wikiMinify?: boolean;
  memoryReaderMode?: "compressed" | "original";
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

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseNonNegativeInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function parseArgs(args: string[]): CliOptions {
  let targetStateId = "";
  let provider: FindCandidateInput["provider"];
  let callerMode: FindCandidateCallerMode = "cli_text";
  let fromToken: number | undefined;
  let readTokens: number | undefined;
  let maxReads: number | undefined;
  let wikiMinify: boolean | undefined;
  let memoryReaderMode: "compressed" | "original" | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--target-state-id" || arg.startsWith("--target-state-id=")) {
      targetStateId = readArgValue(args, index, "--target-state-id").trim();
      if (arg === "--target-state-id") index += 1;
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
      provider = value;
    } else if (arg === "--from-token" || arg.startsWith("--from-token=")) {
      const value = readArgValue(args, index, "--from-token");
      if (arg === "--from-token") index += 1;
      fromToken = parseNonNegativeInteger(value, "--from-token");
    } else if (arg === "--read-tokens" || arg.startsWith("--read-tokens=")) {
      const value = readArgValue(args, index, "--read-tokens");
      if (arg === "--read-tokens") index += 1;
      readTokens = parsePositiveInteger(value, "--read-tokens");
    } else if (arg === "--max-reads" || arg.startsWith("--max-reads=")) {
      const value = readArgValue(args, index, "--max-reads");
      if (arg === "--max-reads") index += 1;
      maxReads = parsePositiveInteger(value, "--max-reads");
    } else if (arg === "--reader-mode" || arg.startsWith("--reader-mode=")) {
      const value = readArgValue(args, index, "--reader-mode").trim();
      if (arg === "--reader-mode") index += 1;
      if (value !== "compressed" && value !== "original") {
        throw new Error("--reader-mode must be compressed or original");
      }
      memoryReaderMode = value;
    } else if (arg === "--wiki-minify") {
      wikiMinify = true;
    } else if (arg === "--wiki-original") {
      wikiMinify = false;
    } else if (arg === "--write") {
      callerMode = "storage";
    } else if (arg === "--text") {
      callerMode = "cli_text";
    } else if (arg === "--json") {
      // no-op: for compatibility
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!targetStateId) {
    throw new Error("--target-state-id is required");
  }

  return {
    targetStateId,
    provider,
    callerMode,
    fromToken,
    readTokens,
    maxReads,
    wikiMinify,
    memoryReaderMode,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const result = await runFindCandidate({
    targetStateId: options.targetStateId,
    provider: options.provider,
    callerMode: options.callerMode,
    fromToken: options.fromToken,
    readTokens: options.readTokens,
    maxReads: options.maxReads,
    wikiMinify: options.wikiMinify,
    memoryReaderMode: options.memoryReaderMode,
  });

  if (options.callerMode === "cli_text") {
    process.stdout.write(`${formatCliTextCandidates(result.candidates)}\n`);
    return;
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        targetStateId: result.targetStateId,
        targetKind: result.targetKind,
        targetKey: result.targetKey,
        candidateCount: result.candidates.length,
        insertedIds: result.insertedIds ?? [],
      },
      null,
      2,
    )}\n`,
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
