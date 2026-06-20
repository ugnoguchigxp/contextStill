import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { resolveDatabaseBackendConfig } from "../src/db/backend.js";

const originalDatabaseUrl = process.env.DATABASE_URL;
const originalBackend = process.env.CONTEXT_STILL_DB_BACKEND;
const originalSqlitePath = process.env.CONTEXT_STILL_SQLITE_CORE_PATH;

afterEach(() => {
  restoreEnv("DATABASE_URL", originalDatabaseUrl);
  restoreEnv("CONTEXT_STILL_DB_BACKEND", originalBackend);
  restoreEnv("CONTEXT_STILL_SQLITE_CORE_PATH", originalSqlitePath);
});

describe("database backend config", () => {
  beforeEach(() => {
    clearEnv("DATABASE_URL");
    clearEnv("CONTEXT_STILL_DB_BACKEND");
    clearEnv("CONTEXT_STILL_SQLITE_CORE_PATH");
  });

  test("defaults postgres for postgres URLs", () => {
    const config = resolveDatabaseBackendConfig({
      databaseUrl: "postgres://postgres:postgres@localhost/context_still",
    });

    expect(config).toEqual({
      kind: "postgres",
      url: "postgres://postgres:postgres@localhost/context_still",
      sqlitePath: null,
    });
  });

  test("infers sqlite from sqlite URL", () => {
    const config = resolveDatabaseBackendConfig({
      databaseUrl: "sqlite:///tmp/context-still-core.sqlite",
    });

    expect(config.kind).toBe("sqlite");
    expect(config.sqlitePath).toBe("/tmp/context-still-core.sqlite");
  });

  test("honors explicit backend when provided", () => {
    const config = resolveDatabaseBackendConfig({
      databaseUrl: "postgres://postgres:postgres@localhost/context_still",
      backend: "sqlite",
      sqlitePath: "/tmp/context-still-core.sqlite",
    });

    expect(config.kind).toBe("sqlite");
    expect(config.sqlitePath).toBe("/tmp/context-still-core.sqlite");
  });

  test("honors sqlite core path env when sqlite backend is selected", () => {
    process.env.CONTEXT_STILL_DB_BACKEND = "sqlite";
    process.env.CONTEXT_STILL_SQLITE_CORE_PATH = "/tmp/context-still-env.sqlite";

    const config = resolveDatabaseBackendConfig();

    expect(config.kind).toBe("sqlite");
    expect(config.sqlitePath).toBe("/tmp/context-still-env.sqlite");
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    clearEnv(key);
    return;
  }
  process.env[key] = value;
}

function clearEnv(key: string): void {
  Reflect.deleteProperty(process.env, key);
}
