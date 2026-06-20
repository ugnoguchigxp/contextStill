import path from "node:path";
import { readProjectEnv } from "../project-identity.js";

export type DatabaseBackendKind = "postgres" | "sqlite";

export type DatabaseBackendConfig = {
  kind: DatabaseBackendKind;
  url: string;
  sqlitePath: string | null;
};

const defaultSqliteCorePath = path.resolve(process.cwd(), "data", "context-still-core.sqlite");

function normalizeBackendKind(value: string | undefined): DatabaseBackendKind | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "postgres" || normalized === "postgresql" || normalized === "pg") {
    return "postgres";
  }
  if (normalized === "sqlite" || normalized === "sqlite3") return "sqlite";
  return null;
}

function sqlitePathFromUrl(url: string): string | null {
  if (normalizeBackendKind(url) === "sqlite") return defaultSqliteCorePath;
  if (url.startsWith("sqlite://")) return url.slice("sqlite://".length);
  if (url.startsWith("file:")) {
    try {
      return new URL(url).pathname;
    } catch {
      return url.slice("file:".length);
    }
  }
  return null;
}

function configuredSqliteCorePath(inputPath?: string): string | undefined {
  return (
    inputPath ??
    process.env.CONTEXT_STILL_SQLITE_CORE_PATH ??
    process.env.MEMORY_ROUTER_SQLITE_CORE_PATH ??
    readProjectEnv("SQLITE_CORE_PATH") ??
    readProjectEnv("DB_SQLITE_PATH")
  );
}

export function resolveDatabaseBackendConfig(input?: {
  databaseUrl?: string;
  backend?: string;
  sqlitePath?: string;
}): DatabaseBackendConfig {
  const url = input?.databaseUrl ?? process.env.DATABASE_URL ?? "";
  const configuredSqlitePath = configuredSqliteCorePath(input?.sqlitePath);
  const requestedBackend =
    normalizeBackendKind(input?.backend) ??
    normalizeBackendKind(process.env.CONTEXT_STILL_DB_BACKEND) ??
    normalizeBackendKind(readProjectEnv("DB_BACKEND"));
  const sqlitePath = sqlitePathFromUrl(url);
  const hasExplicitSqlitePath = Boolean(configuredSqlitePath);
  const inferredKind: DatabaseBackendKind =
    sqlitePath || (!url && hasExplicitSqlitePath) ? "sqlite" : "postgres";
  const kind = requestedBackend ?? inferredKind;

  return {
    kind,
    url,
    sqlitePath:
      kind === "sqlite" ? (configuredSqlitePath ?? sqlitePath ?? defaultSqliteCorePath) : null,
  };
}
