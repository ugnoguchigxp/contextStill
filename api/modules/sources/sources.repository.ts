import { eq } from "drizzle-orm";
import { db } from "../../../src/db/index.js";
import { sources } from "../../../src/db/schema.js";
import {
  auditEventTypes,
  recordAuditLogSafe,
} from "../../../src/modules/audit/audit-log.service.js";

export async function deleteSourceByUri(uri: string) {
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
