import { randomUUID } from "node:crypto";
import { z } from "zod";
import { resolveDatabaseBackendConfig } from "../../db/backend.js";
import { getRuntimeSqliteCoreDatabase } from "../../db/sqlite/runtime.js";
import { canonicalJsonSha256 } from "../../shared/utils/canonical-json.js";
import {
  cancelDeepStill,
  fetchDeepStillDetail,
  projectDeepStillResult,
  submitDeepStill,
  MANUAL_RESEARCH_BUDGET,
  type ManualResearchResult,
} from "./deepstill-client.js";

export const createManualResearchSchema = z.object({
  topic: z.string().trim().min(2).max(400),
  clientRequestKey: z.string().uuid(),
});

type Row = {
  id: string;
  client_request_key: string;
  topic: string;
  request_hash: string;
  plugin_job_id: string | null;
  status: string;
  sync_error: string | null;
  cancel_requested: number;
  result_hash: string | null;
  result_json: string | null;
  created_at: string;
  updated_at: string;
  last_synced_at: string | null;
};

export type ManualResearchRun = {
  id: string;
  topic: string;
  status: string;
  syncError: string | null;
  cancelRequested: boolean;
  resultHash: string | null;
  result: ManualResearchResult | null;
  createdAt: string;
  updatedAt: string;
  lastSyncedAt: string | null;
};

function toPublic(row: Row): ManualResearchRun {
  return {
    id: row.id,
    topic: row.topic,
    status: row.status,
    syncError: row.sync_error,
    cancelRequested: row.cancel_requested === 1,
    resultHash: row.result_hash,
    result: row.result_json ? (JSON.parse(row.result_json) as ManualResearchResult) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSyncedAt: row.last_synced_at,
  };
}

async function database() {
  if (resolveDatabaseBackendConfig().kind !== "sqlite") {
    throw new Error("MANUAL_RESEARCH_REQUIRES_SQLITE");
  }
  return (await getRuntimeSqliteCoreDatabase()).db;
}

async function rawRun(id: string): Promise<Row | null> {
  const db = await database();
  return db.query<Row, [string]>("SELECT * FROM manual_research_runs WHERE id=?").get(id);
}

export async function getManualResearch(id: string): Promise<ManualResearchRun | null> {
  const row = await rawRun(id);
  return row ? toPublic(row) : null;
}

export async function listManualResearch(): Promise<ManualResearchRun[]> {
  const db = await database();
  return db
    .query<Row, []>("SELECT * FROM manual_research_runs ORDER BY created_at DESC LIMIT 100")
    .all()
    .map(toPublic);
}

export class ManualResearchConflict extends Error {}

export async function createManualResearch(
  input: z.infer<typeof createManualResearchSchema>,
): Promise<ManualResearchRun> {
  const db = await database();
  const requestHash = canonicalJsonSha256({
    topic: input.topic,
    mode: "live",
    strategy: "balanced",
    knowledge: false,
    budget: MANUAL_RESEARCH_BUDGET,
  });
  const id = randomUUID();
  const now = new Date().toISOString();
  db.query(
    "INSERT INTO manual_research_runs(id,client_request_key,topic,request_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(client_request_key) DO NOTHING",
  ).run(id, input.clientRequestKey, input.topic, requestHash, "created", now, now);
  const row = db
    .query<Row, [string]>("SELECT * FROM manual_research_runs WHERE client_request_key=?")
    .get(input.clientRequestKey);
  if (!row) throw new Error("MANUAL_RESEARCH_CREATE_NOT_CONFIRMED");
  if (row.request_hash !== requestHash)
    throw new ManualResearchConflict("CLIENT_REQUEST_KEY_CONFLICT");
  void reconcileManualResearch(row.id);
  return toPublic(row);
}

export async function requestManualResearchCancel(id: string): Promise<ManualResearchRun | null> {
  const row = await rawRun(id);
  if (!row) return null;
  if (
    ["completed", "partial", "failed", "cancelled", "invalid_result", "unavailable"].includes(
      row.status,
    )
  )
    return toPublic(row);
  const db = await database();
  const request = db
    .query(
      "UPDATE manual_research_runs SET cancel_requested=1, sync_error=NULL, updated_at=? WHERE id=?",
    )
    .run(new Date().toISOString(), id);
  if (request.changes !== 1) throw new Error("MANUAL_RESEARCH_CANCEL_NOT_CONFIRMED");
  void reconcileManualResearch(id);
  const updated = await getManualResearch(id);
  if (!updated) throw new Error("MANUAL_RESEARCH_CANCEL_NOT_CONFIRMED");
  return updated;
}

const inFlight = new Set<string>();

async function saveSyncError(id: string, error: unknown): Promise<void> {
  const db = await database();
  const message = error instanceof Error ? error.message : String(error);
  const row = await rawRun(id);
  if (
    row?.plugin_job_id === null &&
    /^(DEEPSTILL_TOKEN_NOT_CONFIGURED|DEEPSTILL_ENDPOINT_INVALID|DEEPSTILL_HTTP_401|DEEPSTILL_HTTP_404|DEEPSTILL_SUBMIT_MISMATCH)$/.test(
      message,
    )
  ) {
    const updated = db
      .query(
        "UPDATE manual_research_runs SET status='unavailable',sync_error=?,updated_at=? WHERE id=? AND plugin_job_id IS NULL",
      )
      .run(message, new Date().toISOString(), id);
    if (updated.changes !== 1) throw new Error("MANUAL_RESEARCH_UNAVAILABLE_NOT_CONFIRMED");
    return;
  }
  if (/^DEEPSTILL_(EVIDENCE|SOURCE_URL|REPORT)/.test(message)) {
    const updated = db
      .query(
        "UPDATE manual_research_runs SET status='invalid_result',sync_error=?,updated_at=? WHERE id=? AND result_hash IS NULL",
      )
      .run(message.slice(0, 300), new Date().toISOString(), id);
    if (updated.changes !== 1) throw new Error("MANUAL_RESEARCH_INVALID_RESULT_NOT_CONFIRMED");
    return;
  }
  db.query(
    "UPDATE manual_research_runs SET sync_error=?, updated_at=? WHERE id=? AND result_hash IS NULL",
  ).run(message.slice(0, 300), new Date().toISOString(), id);
}

export async function reconcileManualResearch(id: string): Promise<void> {
  if (inFlight.has(id)) return;
  inFlight.add(id);
  try {
    let row = await rawRun(id);
    if (
      !row ||
      ["completed", "partial", "failed", "cancelled", "invalid_result", "unavailable"].includes(
        row.status,
      )
    )
      return;
    if (row.sync_error && Date.now() - Date.parse(row.updated_at) < 10_000) return;
    const db = await database();
    if (row.cancel_requested && !row.plugin_job_id) {
      const updated = db
        .query(
          "UPDATE manual_research_runs SET status='cancelled',sync_error=NULL,updated_at=? WHERE id=? AND plugin_job_id IS NULL AND status='created'",
        )
        .run(new Date().toISOString(), id);
      if (updated.changes !== 1) throw new Error("MANUAL_RESEARCH_CANCEL_NOT_CONFIRMED");
      return;
    }
    if (!row.plugin_job_id) {
      const job = await submitDeepStill({
        id: row.id,
        topic: row.topic,
        requestHash: row.request_hash,
      });
      if (
        job.topic !== row.topic ||
        job.integration.requestHash !== row.request_hash ||
        job.integration.idempotencyKey !== row.id
      ) {
        throw new Error("DEEPSTILL_SUBMIT_MISMATCH");
      }
      const updated = db
        .query(
          "UPDATE manual_research_runs SET plugin_job_id=?,status=?,sync_error=NULL,updated_at=?,last_synced_at=? WHERE id=? AND plugin_job_id IS NULL",
        )
        .run(job.id, job.status, new Date().toISOString(), new Date().toISOString(), id);
      if (updated.changes !== 1) throw new Error("MANUAL_RESEARCH_SUBMIT_NOT_CONFIRMED");
      row = await rawRun(id);
      if (!row) throw new Error("MANUAL_RESEARCH_RUN_MISSING");
    }
    const pluginJobId = row.plugin_job_id;
    if (!pluginJobId) throw new Error("MANUAL_RESEARCH_PLUGIN_JOB_MISSING");
    if (row.cancel_requested) await cancelDeepStill(pluginJobId);
    const detail = await fetchDeepStillDetail(pluginJobId);
    if (
      detail.job.id !== row.plugin_job_id ||
      detail.job.topic !== row.topic ||
      detail.job.integration.requestHash !== row.request_hash ||
      detail.job.integration.idempotencyKey !== row.id
    ) {
      throw new Error("DEEPSTILL_JOB_MISMATCH");
    }
    const status = detail.job.status;
    const now = new Date().toISOString();
    if (["completed", "partial", "failed", "cancelled"].includes(status)) {
      if (status === "completed" || status === "partial") {
        const { result, resultHash } = projectDeepStillResult(detail);
        const updated = db
          .query(
            "UPDATE manual_research_runs SET status=?,result_hash=?,result_json=?,sync_error=NULL,updated_at=?,last_synced_at=? WHERE id=? AND result_hash IS NULL",
          )
          .run(status, resultHash, JSON.stringify(result), now, now, id);
        if (updated.changes !== 1) {
          const existing = await rawRun(id);
          if (existing?.result_hash !== resultHash)
            throw new Error("MANUAL_RESEARCH_RESULT_CONFLICT");
        }
      } else {
        const updated = db
          .query(
            "UPDATE manual_research_runs SET status=?,sync_error=?,updated_at=?,last_synced_at=? WHERE id=? AND result_hash IS NULL",
          )
          .run(status, detail.job.reason, now, now, id);
        if (updated.changes !== 1) throw new Error("MANUAL_RESEARCH_TERMINAL_NOT_CONFIRMED");
      }
      return;
    }
    const updated = db
      .query(
        "UPDATE manual_research_runs SET status=?,sync_error=NULL,updated_at=?,last_synced_at=? WHERE id=? AND result_hash IS NULL",
      )
      .run(status, now, now, id);
    if (updated.changes !== 1) throw new Error("MANUAL_RESEARCH_STATUS_NOT_CONFIRMED");
  } catch (error) {
    await saveSyncError(id, error).catch(() => {});
  } finally {
    inFlight.delete(id);
  }
}

export async function reconcilePendingManualResearch(): Promise<void> {
  const db = await database();
  const rows = db
    .query<{ id: string }, []>(
      "SELECT id FROM manual_research_runs WHERE status IN ('created','queued','running','finalizing','cancel_requested') ORDER BY updated_at ASC LIMIT 25",
    )
    .all();
  await Promise.all(rows.map((row) => reconcileManualResearch(row.id)));
}

export function startManualResearchReconciler(): void {
  if (process.env.NODE_ENV === "test" || process.env.VITEST === "true") return;
  const state = globalThis as typeof globalThis & {
    __manualResearchTimer?: ReturnType<typeof setInterval>;
  };
  if (state.__manualResearchTimer) return;
  const tick = () => {
    void reconcilePendingManualResearch().catch(() => {});
  };
  state.__manualResearchTimer = setInterval(tick, 10_000);
  state.__manualResearchTimer.unref?.();
  tick();
}
