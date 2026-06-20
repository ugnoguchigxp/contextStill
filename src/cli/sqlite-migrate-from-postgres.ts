#!/usr/bin/env bun

import {
  migratePostgresToSqlite,
  type PostgresToSqliteMigrationMode,
} from "../modules/sqlite-migration/postgres-to-sqlite.service.js";

type Options = {
  mode: PostgresToSqliteMigrationMode;
  sqlitePath?: string;
  databaseUrl?: string;
};

function readArg(args: string[], index: number, name: string): string {
  const arg = args[index];
  if (arg?.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function parseArgs(args: string[]): Options {
  const options: Options = { mode: "dry-run" };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") {
      options.mode = "dry-run";
      continue;
    }
    if (arg === "--apply") {
      options.mode = "insert-only";
      continue;
    }
    if (arg === "--replace") {
      options.mode = "replace";
      continue;
    }
    if (arg === "--sqlite-path" || arg?.startsWith("--sqlite-path=")) {
      options.sqlitePath = readArg(args, index, "--sqlite-path");
      if (arg === "--sqlite-path") index += 1;
      continue;
    }
    if (arg === "--database-url" || arg?.startsWith("--database-url=")) {
      options.databaseUrl = readArg(args, index, "--database-url");
      if (arg === "--database-url") index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "Usage:",
          "  bun run sqlite:migrate-from-postgres -- --dry-run",
          "  bun run sqlite:migrate-from-postgres -- --apply --sqlite-path ./data/context-still-core.sqlite",
          "  bun run sqlite:migrate-from-postgres -- --replace --sqlite-path ./data/context-still-core.sqlite",
        ].join("\n"),
      );
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const summary = await migratePostgresToSqlite(options);
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
