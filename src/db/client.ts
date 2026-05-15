import { drizzle } from "drizzle-orm/node-postgres";
import pkg from "pg";
import { config } from "../config.js";
import * as schema from "./schema.js";

const { Pool } = pkg;

const createDatabase = (pool: InstanceType<typeof Pool>) => drizzle(pool, { schema });

type Database = ReturnType<typeof createDatabase>;

let pool: InstanceType<typeof Pool> | null = null;
let database: Database | null = null;

function ensureDatabase(): Database {
  if (!pool) {
    pool = new Pool({ connectionString: config.databaseUrl });
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
