import os from "node:os";
import { and, eq, isNull, lt, lte, or } from "drizzle-orm";
import { APP_CONSTANTS } from "../../constants.js";
import { distillationTargetStates } from "../../db/schema.js";

export const DEFAULT_DISTILLATION_TARGET_VERSION = APP_CONSTANTS.distillationTargetVersion;

export type DistillationTargetStateRow = typeof distillationTargetStates.$inferSelect;

export type TargetLease = {
  targetStateId: string;
  lockedBy: string;
  attemptCount: number;
};

export function workerId(): string {
  return `${os.hostname()}:${process.pid}`;
}

export function nowMinusSeconds(seconds: number, now = new Date()): Date {
  return new Date(now.getTime() - Math.max(1, seconds) * 1000);
}

export function staleThresholdMs(staleSeconds: number, now = new Date()): number {
  return nowMinusSeconds(staleSeconds, now).getTime();
}

export function rowHeartbeatMs(
  row: Pick<DistillationTargetStateRow, "heartbeatAt" | "lockedAt">,
): number {
  const value = row.heartbeatAt ?? row.lockedAt;
  if (!value) return Number.NEGATIVE_INFINITY;
  return value.getTime();
}

export function targetIdentity(row: DistillationTargetStateRow): Record<string, unknown> {
  return {
    id: row.id,
    targetKind: row.targetKind,
    targetKey: row.targetKey,
    distillationVersion: row.distillationVersion,
    status: row.status,
  };
}

export function leaseFromTargetState(row: DistillationTargetStateRow): TargetLease {
  return {
    targetStateId: row.id,
    lockedBy: row.lockedBy ?? "",
    attemptCount: row.attemptCount,
  };
}

export function targetLeaseWhere(id: string, lease: TargetLease | undefined) {
  const conditions = [eq(distillationTargetStates.id, id)];
  if (lease) {
    conditions.push(
      eq(distillationTargetStates.status, "running"),
      eq(distillationTargetStates.lockedBy, lease.lockedBy),
      eq(distillationTargetStates.attemptCount, lease.attemptCount),
    );
  }
  return and(...conditions);
}

export function statusEligibility(now: Date) {
  return and(
    lt(distillationTargetStates.attemptCount, APP_CONSTANTS.distillationTargetMaxAttempts),
    or(
      eq(distillationTargetStates.status, "pending"),
      and(
        eq(distillationTargetStates.status, "paused"),
        or(
          isNull(distillationTargetStates.nextRetryAt),
          lte(distillationTargetStates.nextRetryAt, now),
        ),
      ),
    ),
  );
}
