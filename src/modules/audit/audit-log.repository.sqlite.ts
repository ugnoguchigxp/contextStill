import { randomUUID } from "node:crypto";
import { redactSecretRecord } from "../../shared/utils/secret-redaction.js";
import type {
  AuditActor,
  AuditLogItem,
  AuditLogListInput,
  AuditLogListResult,
  CleanupAuditLogsResult,
} from "./audit-log.service.js";

type SqliteAuditLogRow = {
  id: string;
  event_type: string;
  actor: string;
  payload: string;
  created_at: string;
};

async function getSqliteCoreDatabase() {
  const { getRuntimeSqliteCoreDatabase } = await import("../../db/sqlite/runtime.js");
  return getRuntimeSqliteCoreDatabase();
}

function normalizeText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function asRecordJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function toDate(value: string): Date {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(0) : date;
}

function mapRow(row: SqliteAuditLogRow): AuditLogItem {
  return {
    id: row.id,
    eventType: row.event_type,
    actor: row.actor,
    payload: asRecordJson(row.payload),
    createdAt: toDate(row.created_at),
  };
}

function normalizePagination(input: AuditLogListInput): { page: number; limit: number } {
  const page = Math.max(1, Math.floor(input.page ?? 1));
  const limit = Math.min(200, Math.max(1, Math.floor(input.limit ?? 50)));
  return { page, limit };
}

export async function recordAuditLogSqlite(input: {
  eventType: string;
  actor: AuditActor;
  payload?: Record<string, unknown>;
  createdAt?: Date;
}): Promise<void> {
  const eventType = normalizeText(input.eventType);
  if (!eventType) return;
  const sqlite = await getSqliteCoreDatabase();
  sqlite.db
    .query(
      `INSERT INTO audit_logs (id, event_type, actor, payload, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      eventType,
      input.actor,
      JSON.stringify(redactSecretRecord(input.payload ?? {})),
      (input.createdAt ?? new Date()).toISOString(),
    );
}

export async function listAuditLogsSqlite(
  input: AuditLogListInput = {},
): Promise<AuditLogListResult> {
  const sqlite = await getSqliteCoreDatabase();
  const { page, limit } = normalizePagination(input);
  const eventType = normalizeText(input.eventType);
  const actor = normalizeText(input.actor);
  const conditions: string[] = [];
  const values: string[] = [];
  if (eventType) {
    conditions.push("event_type = ?");
    values.push(eventType);
  }
  if (actor) {
    conditions.push("actor = ?");
    values.push(actor);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const totalRow = sqlite.db
    .query<{ count: number }, string[]>(`SELECT count(*) AS count FROM audit_logs ${where}`)
    .get(...values);
  const rows = sqlite.db
    .query<SqliteAuditLogRow, Array<string | number>>(
      `SELECT * FROM audit_logs ${where}
       ORDER BY created_at DESC, id DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...values, limit, (page - 1) * limit);
  const typeRows = sqlite.db
    .query<{ event_type: string }, []>(
      "SELECT DISTINCT event_type FROM audit_logs ORDER BY event_type ASC",
    )
    .all();

  return {
    items: rows.map(mapRow),
    total: Number(totalRow?.count ?? 0),
    page,
    limit,
    availableEventTypes: typeRows.map((row) => row.event_type).filter(Boolean),
  };
}

export async function cleanupExpiredAuditLogsSqlite(input?: {
  retentionDays?: number;
  trigger?: string;
}): Promise<CleanupAuditLogsResult> {
  const sqlite = await getSqliteCoreDatabase();
  const retentionDays = Math.max(1, Math.floor(input?.retentionDays ?? 7));
  const trigger = normalizeText(input?.trigger) ?? "unknown";
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const result = sqlite.db
    .query("DELETE FROM audit_logs WHERE created_at < ?")
    .run(cutoff.toISOString());
  return {
    retentionDays,
    trigger,
    cutoffIso: cutoff.toISOString(),
    deletedCount: result.changes,
  };
}
