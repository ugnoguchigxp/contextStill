import path from "node:path";
import { closeDbPool } from "../db/index.js";
import {
  importKnowledgeArchive,
  validateKnowledgeImportArchive,
} from "../modules/knowledge-portability/import.service.js";

type CliOptions = {
  fromDir: string;
  mode: "dry-run" | "insert-only";
};

function readArgValue(args: string[], index: number, name: string): string {
  const arg = args[index];
  if (arg?.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function printHelp(): void {
  console.log(
    [
      "Usage:",
      "  bun run import:knowledge -- --from ./exports/context-still-export --dry-run",
      "  bun run import:knowledge -- --from ./exports/context-still-export --mode insert-only",
    ].join("\n"),
  );
}

function parseArgs(args: string[]): CliOptions {
  let fromDir = "";
  let mode: CliOptions["mode"] | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--from" || arg.startsWith("--from=")) {
      fromDir = path.resolve(readArgValue(args, index, "--from"));
      if (arg === "--from") index += 1;
      continue;
    }
    if (arg === "--dry-run") {
      mode = "dry-run";
      continue;
    }
    if (arg === "--mode" || arg.startsWith("--mode=")) {
      const value = readArgValue(args, index, "--mode");
      if (value !== "insert-only") throw new Error("--mode currently supports only: insert-only");
      mode = value;
      if (arg === "--mode") index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!fromDir) throw new Error("--from is required");
  if (!mode) throw new Error("Specify --dry-run or --mode insert-only");
  return { fromDir, mode };
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { cause?: unknown; code?: unknown };
  if (typeof candidate.code === "string") return candidate.code;
  return errorCode(candidate.cause);
}

function errorDetail(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { cause?: unknown; detail?: unknown };
  if (typeof candidate.detail === "string") return candidate.detail;
  return errorDetail(candidate.cause);
}

function formatCliError(error: unknown): string {
  const code = errorCode(error);
  if (code === "23505") {
    const detail = errorDetail(error);
    return detail
      ? `Insert-only import conflict: ${detail}`
      : "Insert-only import conflict: a row already exists in the target database.";
  }
  if (code) return `Database error ${code}`;
  if (error instanceof Error) {
    if (error.message.startsWith("Failed query:")) return "Database query failed.";
    return error.message;
  }
  return String(error);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const summary =
    options.mode === "dry-run"
      ? await validateKnowledgeImportArchive({
          fromDir: options.fromDir,
          dialect: "postgres",
        })
      : await importKnowledgeArchive({
          fromDir: options.fromDir,
          mode: "insert-only",
          dialect: "postgres",
        });

  console.log(
    JSON.stringify(
      {
        ok: summary.ok,
        mode: options.mode,
        fromDir: summary.fromDir,
        dialect: summary.dialect,
        applied: "applied" in summary ? summary.applied : false,
        statementsExecuted: "statementsExecuted" in summary ? summary.statementsExecuted : 0,
        counts: summary.counts,
        skippedEvidence: summary.skippedEvidence,
        issues: summary.issues,
      },
      null,
      2,
    ),
  );

  if (!summary.ok) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error("[import-knowledge] failed:", formatCliError(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbPool();
  });
