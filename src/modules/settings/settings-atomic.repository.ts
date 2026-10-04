import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { resolveDatabaseBackendConfig } from "../../db/backend.js";
import { db } from "../../db/client.js";
import { settings } from "../../db/schema.js";
import { assertSecretReferenceWrite } from "./settings-secret-write.js";

export type SettingsMutationRow = {
  namespace: string;
  key: string;
  value: Record<string, unknown>;
  expectedVersion: number;
  valueKind?: string;
  secretRef?: string | null;
  isSecret?: boolean;
};
export async function commitSettingsRows(rows: SettingsMutationRow[]): Promise<void> {
  for (const row of rows) assertSecretReferenceWrite(row);
  const now = new Date();
  if (resolveDatabaseBackendConfig().kind === "sqlite") {
    const { getRuntimeSqliteCoreDatabase } = await import("../../db/sqlite/runtime.js");
    const { db: sqlite } = await getRuntimeSqliteCoreDatabase();
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        const prior = sqlite
          .query<{ schema_version: number }, [string, string]>(
            "SELECT schema_version FROM settings WHERE namespace=? AND key=?",
          )
          .get(row.namespace, row.key);
        if ((prior?.schema_version ?? 0) !== row.expectedVersion)
          throw new Error("settings_revision_conflict");
        sqlite
          .query(
            "INSERT INTO settings(id,namespace,key,value,value_kind,secret_ref,is_secret,schema_version,created_at,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value,value_kind=excluded.value_kind,secret_ref=excluded.secret_ref,is_secret=excluded.is_secret,schema_version=excluded.schema_version,updated_at=excluded.updated_at,updated_by=excluded.updated_by",
          )
          .run(
            randomUUID(),
            row.namespace,
            row.key,
            JSON.stringify(row.value),
            row.valueKind ?? "json",
            row.secretRef ?? null,
            row.isSecret ? 1 : 0,
            row.expectedVersion + 1,
            now.toISOString(),
            now.toISOString(),
            "settings-ui",
          );
      }
      sqlite.exec("COMMIT");
    } catch (error) {
      try {
        sqlite.exec("ROLLBACK");
      } catch {
        /* Connection may have lost an acknowledged commit. Caller checks operation record. */
      }
      throw error;
    }
    return;
  }
  await db.transaction(async (tx) => {
    for (const row of rows) {
      const where = and(eq(settings.namespace, row.namespace), eq(settings.key, row.key));
      const [prior] = await tx.select().from(settings).where(where).for("update").limit(1);
      if ((prior?.schemaVersion ?? 0) !== row.expectedVersion)
        throw new Error("settings_revision_conflict");
      const values = {
        value: row.value,
        valueKind: row.valueKind ?? "json",
        secretRef: row.secretRef ?? null,
        isSecret: row.isSecret ?? false,
        schemaVersion: row.expectedVersion + 1,
        updatedAt: now,
        updatedBy: "settings-ui",
      };
      if (prior) await tx.update(settings).set(values).where(where);
      else {
        const created = await tx
          .insert(settings)
          .values({ namespace: row.namespace, key: row.key, ...values })
          .onConflictDoNothing()
          .returning({ id: settings.id });
        if (!created.length) throw new Error("settings_revision_conflict");
      }
    }
  });
}
