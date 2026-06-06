import { findSettingsRow, upsertSettingsRow } from "../../settings/settings.repository.js";
import { type DistillationQueueName, distillationQueueNames } from "./types.js";

const QUEUE_CONTROL_NAMESPACE = "runtime";
const QUEUE_CONTROL_KEY = "queue.controls.v1";

export type QueueControlState = {
  paused: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
  reason: string | null;
};

export type QueueControlStates = Record<DistillationQueueName, QueueControlState>;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function defaultQueueControlState(): QueueControlState {
  return {
    paused: false,
    updatedAt: null,
    updatedBy: null,
    reason: null,
  };
}

function defaultQueueControlStates(): QueueControlStates {
  return {
    findingCandidate: defaultQueueControlState(),
    coveringEvidence: defaultQueueControlState(),
    deadZoneMergeReview: defaultQueueControlState(),
    finalizeDistille: defaultQueueControlState(),
  };
}

function normalizeQueueControlStates(value: unknown): QueueControlStates {
  const root = asRecord(value);
  const rawQueues = asRecord(root.queues);
  const normalized = defaultQueueControlStates();

  for (const queueName of distillationQueueNames) {
    const row = asRecord(rawQueues[queueName]);
    normalized[queueName] = {
      paused: row.paused === true,
      updatedAt: asText(row.updatedAt),
      updatedBy: asText(row.updatedBy),
      reason: asText(row.reason),
    };
  }

  return normalized;
}

function serializeQueueControlStates(states: QueueControlStates): Record<string, unknown> {
  return {
    queues: {
      findingCandidate: states.findingCandidate,
      coveringEvidence: states.coveringEvidence,
      deadZoneMergeReview: states.deadZoneMergeReview,
      finalizeDistille: states.finalizeDistille,
    },
  };
}

export async function getQueueControlStates(): Promise<QueueControlStates> {
  const row = await findSettingsRow(QUEUE_CONTROL_NAMESPACE, QUEUE_CONTROL_KEY);
  return normalizeQueueControlStates(row?.value ?? null);
}

export async function isQueuePaused(queueName: DistillationQueueName): Promise<boolean> {
  const states = await getQueueControlStates();
  return states[queueName].paused;
}

export async function setQueuePaused(params: {
  queueName: DistillationQueueName;
  paused: boolean;
  reason?: string;
  updatedBy?: string | null;
}): Promise<QueueControlStates> {
  const existing = await findSettingsRow(QUEUE_CONTROL_NAMESPACE, QUEUE_CONTROL_KEY);
  const current = normalizeQueueControlStates(existing?.value ?? null);
  const nowIso = new Date().toISOString();

  const next: QueueControlStates = {
    ...current,
    [params.queueName]: {
      paused: params.paused,
      updatedAt: nowIso,
      updatedBy: asText(params.updatedBy ?? null),
      reason: asText(params.reason),
    },
  };

  await upsertSettingsRow({
    namespace: QUEUE_CONTROL_NAMESPACE,
    key: QUEUE_CONTROL_KEY,
    value: serializeQueueControlStates(next),
    valueKind: "json",
    description: "Queue lane pause controls",
    schemaVersion: Math.max(1, (existing?.schemaVersion ?? 0) + 1),
    updatedBy: asText(params.updatedBy ?? null),
  });

  return next;
}
