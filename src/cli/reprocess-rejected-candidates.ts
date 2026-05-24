import { closeDbPool } from "../db/index.js";
import {
  type ReprocessRejectedInput,
  reprocessRejectedCandidates,
} from "../modules/coverEvidence/reprocess-rejected.service.js";

type CliOptions = ReprocessRejectedInput & {
  json: boolean;
};

function readArgValue(args: string[], index: number, name: string): string {
  const inline = args[index]?.match(new RegExp(`^${name}=(.*)$`))?.[1];
  if (inline !== undefined) return inline;
  const next = args[index + 1];
  if (!next || next.startsWith("--")) throw new Error(`${name} requires a value`);
  return next;
}

function readPositiveInteger(args: string[], index: number, name: string): number {
  const value = readArgValue(args, index, name);
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be positive`);
  return parsed;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    reason: "procedure_body_not_actionable",
    limit: 20,
    apply: false,
    allowCompleted: false,
    json: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--reason" || arg.startsWith("--reason=")) {
      options.reason = readArgValue(args, index, "--reason").trim();
      if (arg === "--reason") index += 1;
    } else if (arg === "--candidate-type" || arg.startsWith("--candidate-type=")) {
      const value = readArgValue(args, index, "--candidate-type").trim();
      if (arg === "--candidate-type") index += 1;
      if (value !== "rule" && value !== "procedure") {
        throw new Error("--candidate-type must be rule or procedure");
      }
      options.candidateType = value;
    } else if (arg === "--source" || arg.startsWith("--source=")) {
      options.source = readArgValue(args, index, "--source").trim();
      if (arg === "--source") index += 1;
    } else if (arg === "--limit" || arg.startsWith("--limit=")) {
      options.limit = readPositiveInteger(args, index, "--limit");
      if (arg === "--limit") index += 1;
    } else if (arg === "--apply") {
      options.apply = true;
    } else if (arg === "--dry-run") {
      options.apply = false;
    } else if (arg === "--allow-completed") {
      options.allowCompleted = true;
    } else if (arg === "--json") {
      options.json = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function printText(result: Awaited<ReturnType<typeof reprocessRejectedCandidates>>): void {
  const mode = result.apply ? "apply" : "dry-run";
  process.stdout.write(
    `reprocess rejected candidates (${mode}): matched=${result.matched} updated=${result.updated}\n`,
  );
  for (const item of result.items) {
    process.stdout.write(
      `${[
        item.proposedAction,
        item.applied ? "applied" : "pending",
        item.coverEvidenceResultId,
        item.originalType ?? "unknown",
        item.targetStatus,
        item.currentReason ?? "no_reason",
        item.title,
      ].join("\t")}\n`,
    );
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const result = await reprocessRejectedCandidates(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    printText(result);
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
