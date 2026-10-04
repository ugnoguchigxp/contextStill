import type { SqliteCoreDatabase } from "../../../db/sqlite/client.js";
import { legacyProtocolPredicate } from "./legacy-protocol.js";

type FindingInput = {
  inputKind: string;
  sourceKind: string;
  sourceKey: string;
  sourceUri: string;
  distillationVersion: string;
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  priority: number;
};

/** Ordinary ingress is idempotent for versioned runs. Reprocessing needs an explicit new
 * input generation; it must not steal an active claim or reset a saved run's budget. */
export function enqueueSqliteFindingJob(db: SqliteCoreDatabase["db"], input: FindingInput) {
  const now = new Date().toISOString();
  const keys = [input.inputKind, input.sourceKind, input.sourceKey, input.distillationVersion];
  const find = () =>
    db
      .query<Record<string, unknown>>(`select * from finding_candidate_queue
      where input_kind=? and source_kind=? and source_key=? and distillation_version=? limit 1`)
      .get(...keys);
  const existing = find();
  if (existing && (Number(existing.protocol_version ?? 1) >= 3 || existing.status === "running")) {
    return { row: existing, changed: false };
  }
  const writable = legacyProtocolPredicate(db, "findingCandidate");
  let changes: number;
  if (existing) {
    // Recheck the protocol in the mutation: a resident may have pinned it since the read.
    ({ changes } = db
      .query(`update finding_candidate_queue set source_uri=?, payload=?,
      metadata=?, priority=?, next_run_at=null, completed_at=null, status='pending',
      locked_by=null, locked_at=null, heartbeat_at=null, updated_at=? where id=? and status!='running' and ${writable}`)
      .run(
        input.sourceUri,
        JSON.stringify(input.payload ?? {}),
        JSON.stringify(input.metadata ?? {}),
        input.priority,
        now,
        String(existing.id),
      ));
  } else {
    ({ changes } = db
      .query(`insert into finding_candidate_queue
      (id,input_kind,source_kind,source_key,source_uri,distillation_version,payload,metadata,
       priority,status,created_at,updated_at) values(?,?,?,?,?,?,?,?,?,'pending',?,?)
      on conflict(input_kind,source_kind,source_key,distillation_version) do nothing`)
      .run(
        crypto.randomUUID(),
        ...keys.slice(0, 3),
        input.sourceUri,
        input.distillationVersion,
        JSON.stringify(input.payload ?? {}),
        JSON.stringify(input.metadata ?? {}),
        input.priority,
        now,
        now,
      ));
  }
  const row = find();
  if (!row) throw new Error("failed to enqueue finding candidate job");
  return { row, changed: changes > 0 };
}
