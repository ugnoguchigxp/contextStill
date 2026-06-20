import { resolveDatabaseBackendConfig } from "../../../db/backend.js";
import { db } from "../../../db/index.js";
import { distillationQueueEvents } from "../../../db/schema.js";
import type { DistillationQueueName } from "./types.js";

async function getSqliteCoreDatabase() {
  const { getRuntimeSqliteCoreDatabase } = await import("../../../db/sqlite/runtime.js");
  return getRuntimeSqliteCoreDatabase();
}

export async function appendQueueEvent(params: {
  queueName: DistillationQueueName;
  queueJobId: string;
  eventType: string;
  message?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  if (resolveDatabaseBackendConfig().kind === "sqlite") {
    const sqlite = await getSqliteCoreDatabase();
    sqlite.db
      .query(
        `
        insert into distillation_queue_events (
          id, queue_name, queue_job_id, event_type, message, metadata, created_at
        ) values (?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        crypto.randomUUID(),
        params.queueName,
        params.queueJobId,
        params.eventType,
        params.message ?? null,
        JSON.stringify(params.metadata ?? {}),
        new Date().toISOString(),
      );
    return;
  }

  await db.insert(distillationQueueEvents).values({
    queueName: params.queueName,
    queueJobId: params.queueJobId,
    eventType: params.eventType,
    message: params.message ?? null,
    metadata: params.metadata ?? {},
  });
}
