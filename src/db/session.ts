import { db as defaultDb } from "./index.js";
import type { DatabaseBackendKind } from "./backend.js";

export type DatabaseClient = typeof defaultDb;

export type DatabaseSessionMode = "read" | "write";

export type DatabaseSession = {
  db: DatabaseClient;
  mode: DatabaseSessionMode;
  backend: DatabaseBackendKind;
};

export function getDefaultDbSession(mode: DatabaseSessionMode = "read"): DatabaseSession {
  return { db: defaultDb, mode, backend: "postgres" };
}

export async function withDbSession<T>(fn: (session: DatabaseSession) => Promise<T>): Promise<T> {
  return fn(getDefaultDbSession("read"));
}

export async function withWriteSession<T>(
  fn: (session: DatabaseSession) => Promise<T>,
): Promise<T> {
  return fn(getDefaultDbSession("write"));
}

export async function withDbTransaction<T>(
  fn: (session: DatabaseSession) => Promise<T>,
): Promise<T> {
  return defaultDb.transaction((tx) =>
    fn({
      db: tx as unknown as DatabaseClient,
      mode: "write",
      backend: "postgres",
    }),
  );
}
