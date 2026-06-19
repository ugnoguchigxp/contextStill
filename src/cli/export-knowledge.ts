import path from "node:path";
import { closeDbPool } from "../db/index.js";
import { exportKnowledgeArchive } from "../modules/knowledge-portability/export.service.js";

function readArgValue(args: string[], index: number, name: string): string {
  const arg = args[index];
  if (arg?.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function parseArgs(args: string[]): { outDir: string } {
  let outDir = path.resolve(process.cwd(), "exports/context-still-export");

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--out" || arg.startsWith("--out=")) {
      outDir = path.resolve(readArgValue(args, index, "--out"));
      if (arg === "--out") index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log("Usage: bun run export:knowledge -- --out ./exports/context-still-export");
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { outDir };
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { cause?: unknown; code?: unknown };
  if (typeof candidate.code === "string") return candidate.code;
  return errorCode(candidate.cause);
}

function formatCliError(error: unknown): string {
  const code = errorCode(error);
  if (code === "ECONNREFUSED") {
    return "PostgreSQL connection refused. Start the configured database and retry the export.";
  }
  if (code) return `Database error ${code}.`;
  if (error instanceof Error && error.message.startsWith("Failed query:")) {
    return "Database query failed.";
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const summary = await exportKnowledgeArchive(options);
  console.log(
    JSON.stringify(
      {
        outDir: summary.outDir,
        manifestPath: summary.manifestPath,
        sqlPath: summary.sqlPath,
        evidenceIndexPath: summary.evidenceIndexPath,
        checksumsPath: summary.checksumsPath,
        counts: summary.manifest.counts,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error("[export-knowledge] failed:", formatCliError(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbPool();
  });
