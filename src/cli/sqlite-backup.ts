#!/usr/bin/env bun

import { mkdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveDatabaseBackendConfig } from "../db/backend.js";
import { openSqliteCoreDatabase } from "../db/sqlite/index.js";

type Options = {
  output: string | null;
  json: boolean;
};

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function parseArgs(args: string[]): Options {
  const options: Options = { output: null, json: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--output" || arg === "-o") {
      const value = args[index + 1];
      if (!value) throw new Error(`${arg} requires a path`);
      options.output = value;
      index += 1;
      continue;
    }
    if (arg?.startsWith("--output=")) {
      options.output = arg.slice("--output=".length);
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log("Usage: bun run src/cli/sqlite-backup.ts [--output path] [--json]");
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function defaultOutputPath(sourcePath: string): string {
  const parsed = path.parse(sourcePath);
  return path.join(
    parsed.dir,
    "backups",
    `${parsed.name}-${timestamp()}${parsed.ext || ".sqlite"}`,
  );
}

function sqliteStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const config = resolveDatabaseBackendConfig({ backend: "sqlite" });
  if (!config.sqlitePath) {
    throw new Error("SQLite backend path could not be resolved");
  }

  const source = path.resolve(config.sqlitePath);
  const output = path.resolve(options.output ?? defaultOutputPath(config.sqlitePath));
  if (output === source) {
    throw new Error("SQLite backup output must be different from the source database path");
  }

  const sourceStat = await stat(source).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!sourceStat?.isFile()) {
    throw new Error(`SQLite source database not found: ${source}`);
  }

  await mkdir(path.dirname(output), { recursive: true });

  const sqlite = await openSqliteCoreDatabase({
    path: source,
    loadVectorExtension: false,
  });
  try {
    sqlite.db.exec("PRAGMA wal_checkpoint(PASSIVE);");
    const integrity = sqlite.db.query<{ integrity_check: string }>("PRAGMA integrity_check;").get();
    if (integrity?.integrity_check !== "ok") {
      throw new Error(`SQLite integrity_check failed: ${integrity?.integrity_check ?? "unknown"}`);
    }
    sqlite.db.exec(`VACUUM INTO ${sqliteStringLiteral(output)};`);
    const outputStat = await stat(output);
    const result = {
      source,
      output,
      bytes: outputStat.size,
      host: os.hostname(),
      createdAt: new Date().toISOString(),
    };
    console.log(
      options.json ? JSON.stringify(result, null, 2) : `SQLite backup written: ${output}`,
    );
  } finally {
    sqlite.db.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
