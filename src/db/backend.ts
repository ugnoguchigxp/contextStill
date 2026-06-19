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

export function resolveDatabaseBackendConfig(input?: {
  databaseUrl?: string;
  backend?: string;
  sqlitePath?: string;
}): DatabaseBackendConfig {
  const url = input?.databaseUrl ?? process.env.DATABASE_URL ?? "";
  const configuredSqlitePath =
    input?.sqlitePath ?? readProjectEnv("SQLITE_CORE_PATH") ?? readProjectEnv("DB_SQLITE_PATH");
  const requestedBackend =
    normalizeBackendKind(input?.backend) ??
    normalizeBackendKind(readProjectEnv("DB_BACKEND")) ??
    normalizeBackendKind(process.env.CONTEXT_STILL_DB_BACKEND);
  const sqlitePath = sqlitePathFromUrl(url);
  const inferredKind: DatabaseBackendKind = sqlitePath ? "sqlite" : "postgres";
  const kind = requestedBackend ?? inferredKind;

  return {
    kind,
    url,
    sqlitePath:
      kind === "sqlite" ? (configuredSqlitePath ?? sqlitePath ?? defaultSqliteCorePath) : null,
  };
}
