import { and, asc, eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { settings } from "../../db/schema.js";

export const SETTINGS_DOCUMENT_NAMESPACE = "runtime";
export const SETTINGS_DOCUMENT_KEY = "settings.v1";
export const SETTINGS_SECRET_NAMESPACE = "runtime.secret";

export type SettingsRow = {
  id: string;
  namespace: string;
  key: string;
  value: Record<string, unknown>;
  valueKind: string;
  secretRef: string | null;
  isSecret: boolean;
  description: string | null;
  schemaVersion: number;
  createdAt: Date;
  updatedAt: Date;
  updatedBy: string | null;
};

function normalizeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function mapRow(row: {
  id: string;
  namespace: string;
  key: string;
  value: unknown;
  valueKind: string;
  secretRef: string | null;
  isSecret: boolean;
  description: string | null;
  schemaVersion: number;
  createdAt: Date;
  updatedAt: Date;
  updatedBy: string | null;
}): SettingsRow {
  return {
    id: row.id,
    namespace: row.namespace,
    key: row.key,
    value: normalizeRecord(row.value),
    valueKind: row.valueKind,
    secretRef: row.secretRef,
    isSecret: row.isSecret,
    description: row.description,
    schemaVersion: row.schemaVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  };
}

export async function findSettingsRow(namespace: string, key: string): Promise<SettingsRow | null> {
  const [row] = await db
    .select({
      id: settings.id,
      namespace: settings.namespace,
      key: settings.key,
      value: settings.value,
      valueKind: settings.valueKind,
      secretRef: settings.secretRef,
      isSecret: settings.isSecret,
      description: settings.description,
      schemaVersion: settings.schemaVersion,
      createdAt: settings.createdAt,
      updatedAt: settings.updatedAt,
      updatedBy: settings.updatedBy,
    })
    .from(settings)
    .where(and(eq(settings.namespace, namespace), eq(settings.key, key)))
    .limit(1);
  return row ? mapRow(row) : null;
}

export async function listSettingsRows(namespace?: string): Promise<SettingsRow[]> {
  const rows = await db
    .select({
      id: settings.id,
      namespace: settings.namespace,
      key: settings.key,
      value: settings.value,
      valueKind: settings.valueKind,
      secretRef: settings.secretRef,
      isSecret: settings.isSecret,
      description: settings.description,
      schemaVersion: settings.schemaVersion,
      createdAt: settings.createdAt,
      updatedAt: settings.updatedAt,
      updatedBy: settings.updatedBy,
    })
    .from(settings)
    .where(namespace ? eq(settings.namespace, namespace) : undefined)
    .orderBy(asc(settings.namespace), asc(settings.key));
  return rows.map(mapRow);
}

export async function upsertSettingsRow(input: {
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
  const now = new Date();
  const inserted = await db
    .insert(settings)
    .values({
      namespace: input.namespace,
      key: input.key,
      value: input.value,
      valueKind: input.valueKind ?? "json",
      secretRef: input.secretRef ?? null,
      isSecret: input.isSecret ?? false,
      description: input.description ?? null,
      schemaVersion: input.schemaVersion,
      updatedAt: now,
      updatedBy: input.updatedBy ?? null,
    })
    .onConflictDoUpdate({
      target: [settings.namespace, settings.key],
      set: {
        value: input.value,
        valueKind: input.valueKind ?? "json",
        secretRef: input.secretRef ?? null,
        isSecret: input.isSecret ?? false,
        description: input.description ?? null,
        schemaVersion: input.schemaVersion,
        updatedAt: now,
        updatedBy: input.updatedBy ?? null,
      },
    })
    .returning({
      id: settings.id,
      namespace: settings.namespace,
      key: settings.key,
      value: settings.value,
      valueKind: settings.valueKind,
      secretRef: settings.secretRef,
      isSecret: settings.isSecret,
      description: settings.description,
      schemaVersion: settings.schemaVersion,
      createdAt: settings.createdAt,
      updatedAt: settings.updatedAt,
      updatedBy: settings.updatedBy,
    });
  const row = inserted[0];
  if (!row) {
    throw new Error(`failed to upsert setting: ${input.namespace}.${input.key}`);
  }
  return mapRow(row);
}

export async function deleteSettingsRow(namespace: string, key: string): Promise<void> {
  await db.delete(settings).where(and(eq(settings.namespace, namespace), eq(settings.key, key)));
}
