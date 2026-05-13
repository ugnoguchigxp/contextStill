import { closeDbPool } from "../db/index.js";
import { compileContextPack } from "../modules/context-compiler/context-compiler.service.js";
import type { CompileInput } from "../shared/schemas/compile.schema.js";

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

function readArgs(name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] === name && process.argv[i + 1]) {
      values.push(process.argv[i + 1] ?? "");
    }
  }
  return values;
}

function parseCsvArgs(values: string[]): string[] {
  const items = values
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return [...new Set(items)];
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  throw new Error(`Invalid boolean value: ${value}`);
}

function parseNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid number value: ${value}`);
  }
  return parsed;
}

function parseEmbedding(value: string | undefined): number[] | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed) || parsed.some((item) => !Number.isFinite(Number(item)))) {
      throw new Error("Invalid --query-embedding JSON array");
    }
    return parsed.map((item) => Number(item));
  }

  const csv = trimmed
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => Number(item));

  if (csv.length === 0 || csv.some((item) => !Number.isFinite(item))) {
    throw new Error("Invalid --query-embedding CSV values");
  }
  return csv;
}

async function main(): Promise<void> {
  const goal = readArg("--goal") || process.argv[2];
  if (!goal) {
    console.error(
      [
        'Usage: bun run compile --goal "your task goal"',
        "[--intent edit]",
        "[--retrieval-mode skill_context]",
        "[--repo-path /path/to/repo]",
        "[--files fileA.ts,fileB.ts | --file fileA.ts --file fileB.ts]",
        "[--change-types backend,api]",
        "[--technologies bun,typescript]",
        "[--token-budget 3000]",
        "[--include-trial true|false]",
        '[--query-embedding "[0.1,0.2,...]" | --query-embedding 0.1,0.2,...]',
        "[--json]",
      ].join(" "),
    );
    process.exitCode = 1;
    return;
  }

  const intent =
    (readArg("--intent") as "plan" | "edit" | "debug" | "review" | "finish" | undefined) ?? "edit";
  const retrievalMode = readArg("--retrieval-mode") as CompileInput["retrievalMode"] | undefined;
  const repoPath = readArg("--repo-path");
  const files = parseCsvArgs([...readArgs("--files"), ...readArgs("--file")]);
  const changeTypes = parseCsvArgs([...readArgs("--change-types"), ...readArgs("--change-type")]);
  const technologies = parseCsvArgs([...readArgs("--technologies"), ...readArgs("--technology")]);
  const tokenBudget = parseNumber(readArg("--token-budget"));
  const includeTrial = parseBoolean(readArg("--include-trial"));
  const queryEmbedding = parseEmbedding(readArg("--query-embedding"));
  const asJson = process.argv.includes("--json");

  const compileInput: CompileInput = {
    goal,
    intent,
    includeTrial: includeTrial ?? false,
    ...(retrievalMode ? { retrievalMode } : {}),
    ...(repoPath ? { repoPath } : {}),
    ...(files.length > 0 ? { files } : {}),
    ...(changeTypes.length > 0 ? { changeTypes } : {}),
    ...(technologies.length > 0 ? { technologies } : {}),
    ...(tokenBudget !== undefined ? { tokenBudget } : {}),
    ...(queryEmbedding ? { queryEmbedding } : {}),
  };

  const result = await compileContextPack(compileInput);
  if (asJson) {
    console.log(JSON.stringify(result.pack, null, 2));
  } else {
    console.log(result.markdown);
  }
}

main()
  .catch((error) => {
    console.error("[compile] failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbPool();
  });
