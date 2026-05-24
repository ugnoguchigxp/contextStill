import { and, count, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { db } from "../../../src/db/index.js";
import { distillationTargetStates } from "../../../src/db/schema.js";
import { APP_CONSTANTS } from "../../../src/constants.js";
import {
  pauseDistillationTargetState,
  requeueDistillationTargetState,
} from "../../../src/modules/selectDistillationTarget/repository.js";
import type {
  DistillationTargetKind,
  DistillationTargetStatus,
} from "../../../src/modules/selectDistillationTarget/domain.js";

const DEFAULT_VERSION = APP_CONSTANTS.distillationTargetVersion;

export type QueueListQuery = {
  page: number;
  limit: number;
  query?: string;
  targetKind?: DistillationTargetKind | "all";
  status?: DistillationTargetStatus | "all";
};

export async function fetchQueueDashboardStats() {
  const stats = await db
    .select({
      status: distillationTargetStates.status,
      count: count(),
    })
    .from(distillationTargetStates)
    .where(eq(distillationTargetStates.distillationVersion, DEFAULT_VERSION))
    .groupBy(distillationTargetStates.status);

  // Group by kind too
  const kinds = await db
    .select({
      targetKind: distillationTargetStates.targetKind,
      count: count(),
    })
    .from(distillationTargetStates)
    .where(eq(distillationTargetStates.distillationVersion, DEFAULT_VERSION))
    .groupBy(distillationTargetStates.targetKind);

  return {
    stats: stats.reduce(
      (acc, curr) => {
        acc[curr.status] = Number(curr.count ?? 0);
        return acc;
      },
      {} as Record<string, number>,
    ),
    kinds: kinds.reduce(
      (acc, curr) => {
        acc[curr.targetKind] = Number(curr.count ?? 0);
        return acc;
      },
      {} as Record<string, number>,
    ),
  };
}

export async function listQueueItems(params: QueueListQuery) {
  const page = Math.max(1, params.page);
  const limit = Math.max(1, Math.min(100, params.limit));
  const offset = (page - 1) * limit;

  const conditions: SQL[] = [eq(distillationTargetStates.distillationVersion, DEFAULT_VERSION)];

  if (params.targetKind && params.targetKind !== "all") {
    conditions.push(eq(distillationTargetStates.targetKind, params.targetKind));
  }

  if (params.status && params.status !== "all") {
    conditions.push(eq(distillationTargetStates.status, params.status));
  }

  if (params.query?.trim()) {
    const term = `%${params.query.trim()}%`;
    const textMatch = or(
      ilike(distillationTargetStates.targetKey, term),
      ilike(distillationTargetStates.sourceUri, term),
    );
    if (textMatch) {
      conditions.push(textMatch);
    }
  }

  const whereClause =
    and(...conditions) ?? eq(distillationTargetStates.distillationVersion, DEFAULT_VERSION);

  const [totalResult] = await db
    .select({ count: count() })
    .from(distillationTargetStates)
    .where(whereClause);

  const items = await db
    .select()
    .from(distillationTargetStates)
    .where(whereClause)
    .orderBy(
      // prioritize running and pending
      sql`case
        when ${distillationTargetStates.status} = 'running' then 0
        when ${distillationTargetStates.status} = 'pending' then 1
        when ${distillationTargetStates.status} = 'failed' then 2
        when ${distillationTargetStates.status} = 'paused' then 3
        else 4
      end asc`,
      desc(distillationTargetStates.updatedAt),
      desc(distillationTargetStates.createdAt),
    )
    .limit(limit)
    .offset(offset);

  return {
    items,
    total: Number(totalResult?.count ?? 0),
    page,
    limit,
  };
}

export async function fetchActiveTasks() {
  return db
    .select()
    .from(distillationTargetStates)
    .where(
      and(
        eq(distillationTargetStates.distillationVersion, DEFAULT_VERSION),
        eq(distillationTargetStates.status, "running"),
      ),
    )
    .orderBy(desc(distillationTargetStates.lockedAt));
}

export async function pauseTarget(id: string, reason: string) {
  return pauseDistillationTargetState({
    id,
    reason,
  });
}

export async function resumeTarget(id: string) {
  return requeueDistillationTargetState({
    id,
    reason: "resumed from control plane",
    allowCompleted: true,
  });
}
