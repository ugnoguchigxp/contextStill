import { drizzle } from "drizzle-orm/node-postgres";
import pkg from "pg";
import { groupedConfig } from "../config.js";
import * as schema from "./schema.js";

const { Pool } = pkg;

const createDatabase = (pool: InstanceType<typeof Pool>) => drizzle(pool, { schema });

type Database = ReturnType<typeof createDatabase>;

let pool: InstanceType<typeof Pool> | null = null;
let database: Database | null = null;

function isVitestRuntime(): boolean {
  return (
    process.env.VITEST === "true" ||
    process.env.VITEST_WORKER_ID !== undefined ||
    process.env.NODE_ENV === "test"
  );
}

function isSafeTestDatabase(databaseUrl: string): boolean {
  try {
    const url = new URL(databaseUrl);
    return url.pathname.replace(/^\//, "").includes("test");
  } catch {
    return databaseUrl.includes("test");
  }
}

function assertSafeTestDatabase(databaseUrl: string): void {
  if (!isVitestRuntime()) return;
  if (isSafeTestDatabase(databaseUrl)) return;
  if (process.env.MEMORY_ROUTER_ALLOW_DESTRUCTIVE_DB_TESTS === "1") return;

  throw new Error(
    [
      "Refusing to open a non-test database from Vitest.",
      "Use a DATABASE_URL whose database name includes 'test', or set MEMORY_ROUTER_ALLOW_DESTRUCTIVE_DB_TESTS=1 explicitly.",
    ].join(" "),
  );
}

function ensureDatabase(): Database {
  if (!pool) {
    assertSafeTestDatabase(groupedConfig.database.url);
    pool = new Pool({ connectionString: groupedConfig.database.url });
  }
  if (!database) {
    database = createDatabase(pool);
  }
  return database;
}

export function getDb(): Database {
  return ensureDatabase();
}

export async function closeDbPool(): Promise<void> {
  if (!pool) return;
  const current = pool;
  pool = null;
  database = null;
  await current.end();
}

export const db = new Proxy({} as Database, {
  get(_target, property, receiver) {
    return Reflect.get(ensureDatabase() as object, property, receiver);
  },
}) as Database;
