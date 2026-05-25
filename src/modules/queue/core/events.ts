import { db } from "../../../db/index.js";
import { distillationQueueEvents } from "../../../db/schema.js";
import type { DistillationQueueName } from "./types.js";

export async function appendQueueEvent(params: {
  queueName: DistillationQueueName;
  queueJobId: string;
  eventType: string;
  message?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await db.insert(distillationQueueEvents).values({
    queueName: params.queueName,
    queueJobId: params.queueJobId,
    eventType: params.eventType,
    message: params.message ?? null,
    metadata: params.metadata ?? {},
  });
}
