import { eq } from "drizzle-orm";
import { resolveDatabaseBackendConfig } from "../../../src/db/backend.js";
import { db } from "../../../src/db/index.js";
import { sqliteSources } from "../../../src/db/sqlite/schema.js";
import { sources } from "../../../src/db/schema.js";
import {
  auditEventTypes,
  recordAuditLogSafe,
} from "../../../src/modules/audit/audit-log.service.js";

async function getSqliteCoreDatabase() {
  const { getRuntimeSqliteCoreDatabase } = await import("../../../src/db/sqlite/runtime.js");
  return getRuntimeSqliteCoreDatabase();
}

export async function deleteSourceByUri(uri: string) {
  if (resolveDatabaseBackendConfig().kind === "sqlite") {
    const sqlite = await getSqliteCoreDatabase();
    const deleted = sqlite.orm
      .select({ id: sqliteSources.id })
      .from(sqliteSources)
      .where(eq(sqliteSources.uri, uri))
      .limit(1)
      .get();
    if (deleted) {
      sqlite.db.query("DELETE FROM sources_fts WHERE id = ?;").run(deleted.id);
      sqlite.orm.delete(sqliteSources).where(eq(sqliteSources.id, deleted.id)).run();
      await recordAuditLogSafe({
        eventType: auditEventTypes.sourceDeleted,
        actor: "user",
        payload: {
          sourceId: deleted.id,
          uri,
        },
      });
    }
    return deleted ?? null;
  }

  const [deleted] = await db
    .delete(sources)
    .where(eq(sources.uri, uri))
    .returning({ id: sources.id });
  if (deleted) {
    await recordAuditLogSafe({
      eventType: auditEventTypes.sourceDeleted,
      actor: "user",
      payload: {
        sourceId: deleted.id,
        uri,
      },
    });
  }
  return deleted ?? null;
}
