import { randomUUID } from "node:crypto";
import type { SettingsRow } from "./settings.repository.js";

type SqliteSettingsRow = {
  id: string;
  namespace: string;
  key: string;
  value: string;
  value_kind: string;
  secret_ref: string | null;
  is_secret: number;
  description: string | null;
  schema_version: number;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
};

async function getSqliteCoreDatabase() {
  const { getRuntimeSqliteCoreDatabase } = await import("../../db/sqlite/runtime.js");
  return getRuntimeSqliteCoreDatabase();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseValue(value: string): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return {};
  }
}

function toDate(value: string): Date {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(0) : date;
}

function mapRow(row: SqliteSettingsRow): SettingsRow {
  return {
    id: row.id,
    namespace: row.namespace,
    key: row.key,
    value: parseValue(row.value),
    valueKind: row.value_kind,
    secretRef: row.secret_ref,
    isSecret: row.is_secret === 1,
    description: row.description,
    schemaVersion: row.schema_version,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
    updatedBy: row.updated_by,
  };
}

export async function findSettingsRowSqlite(
  namespace: string,
  key: string,
): Promise<SettingsRow | null> {
  const sqlite = await getSqliteCoreDatabase();
  const row = sqlite.db
    .query<SqliteSettingsRow, [string, string]>(
      "SELECT * FROM settings WHERE namespace = ? AND key = ? LIMIT 1",
    )
    .get(namespace, key);
  return row ? mapRow(row) : null;
}

export async function listSettingsRowsSqlite(namespace?: string): Promise<SettingsRow[]> {
  const sqlite = await getSqliteCoreDatabase();
  const rows = namespace
    ? sqlite.db
        .query<SqliteSettingsRow, [string]>(
          "SELECT * FROM settings WHERE namespace = ? ORDER BY namespace ASC, key ASC",
        )
        .all(namespace)
    : sqlite.db
        .query<SqliteSettingsRow, []>("SELECT * FROM settings ORDER BY namespace ASC, key ASC")
        .all();
  return rows.map(mapRow);
}

export async function upsertSettingsRowSqlite(input: {
  namespace: string;
  key: string;
  value: Record<string, unknown>;
  valueKind?: string;
  secretRef?: string | null;
  isSecret?: boolean;
  description?: string | null;
  schemaVersion: number;
  updatedBy?: string | null;
}): Promise<SettingsRow> {
  const sqlite = await getSqliteCoreDatabase();
  const now = new Date().toISOString();
  const id = randomUUID();
  sqlite.db
    .query(
      `INSERT INTO settings (
        id, namespace, key, value, value_kind, secret_ref, is_secret,
        description, schema_version, created_at, updated_at, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(namespace, key) DO UPDATE SET
        value = excluded.value,
        value_kind = excluded.value_kind,
        secret_ref = excluded.secret_ref,
        is_secret = excluded.is_secret,
        description = excluded.description,
        schema_version = excluded.schema_version,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by`,
    )
    .run(
      id,
      input.namespace,
      input.key,
      JSON.stringify(input.value),
      input.valueKind ?? "json",
      input.secretRef ?? null,
      input.isSecret ? 1 : 0,
      input.description ?? null,
      Math.max(1, Math.trunc(input.schemaVersion)),
      now,
      now,
      input.updatedBy ?? null,
    );
  const row = await findSettingsRowSqlite(input.namespace, input.key);
  if (!row) throw new Error(`failed to upsert setting: ${input.namespace}.${input.key}`);
  return row;
}

export async function deleteSettingsRowSqlite(namespace: string, key: string): Promise<void> {
  const sqlite = await getSqliteCoreDatabase();
  sqlite.db.query("DELETE FROM settings WHERE namespace = ? AND key = ?").run(namespace, key);
}
