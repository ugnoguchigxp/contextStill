import { resolveDatabaseBackendConfig } from "../backend.js";
import { openSqliteCoreDatabase, type SqliteCoreDatabase } from "./client.js";

let runtimeDatabase: Promise<SqliteCoreDatabase> | undefined;

export function getRuntimeSqliteCoreDatabase(): Promise<SqliteCoreDatabase> {
  if (!runtimeDatabase) {
    const config = resolveDatabaseBackendConfig({ backend: "sqlite" });
    if (!config.sqlitePath) {
      throw new Error("SQLite backend selected but no sqlitePath could be resolved");
    }
    runtimeDatabase = openSqliteCoreDatabase({ path: config.sqlitePath });
  }
  return runtimeDatabase;
}

export function resetRuntimeSqliteCoreDatabaseForTests(): void {
  runtimeDatabase = undefined;
}
