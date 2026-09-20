import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type RecoverySqliteDatabase,
  recoverLarmProviderFailures,
  traceLarmRecoveryBatch,
} from "../src/modules/queue/core/larm-provider-recovery.js";

let database: Database;

function seedSchema(): void {
  for (const table of ["finding_candidate_queue", "episode_distiller_queue"]) {
    database.exec(`
      create table ${table} (
        id text primary key, status text not null, attempt_count integer not null,
        payload text not null default '{}', next_run_at text, completed_at text,
        locked_by text, locked_at text, heartbeat_at text, last_error text,
        last_outcome_kind text, updated_at text not null
      ) strict;
    `);
  }
  database.exec(`
    create table distillation_queue_events (
      id text primary key, queue_name text not null, queue_job_id text not null,
      event_type text not null, message text, metadata text not null default '{}',
      created_at text not null
    ) strict;
    create table llm_provider_leases (
      id text primary key, target_id text not null, queue_name text not null,
      queue_job_id text not null, status text not null, release_reason text,
      created_at text not null
    ) strict;
  `);
}

function insertCandidate(table: string, id: string, error: string): void {
  database
    .query(
      `insert into ${table} (id, status, attempt_count, last_error, last_outcome_kind, updated_at)
       values (?, 'paused', 6, ?, 'provider_unavailable_exhausted', '2026-09-20 12:00:00')`,
    )
    .run(id, error);
}

describe("LARM provider failure recovery", () => {
  beforeEach(() => {
    database = new Database(":memory:", { strict: true });
    seedSchema();
    insertCandidate(
      "finding_candidate_queue",
      "finding-1",
      "request http://192.168.0.130:9810/v1/chat/completions: No route to host (os error 65)",
    );
    insertCandidate(
      "episode_distiller_queue",
      "episode-1",
      "local-llm request failed: error sending request for url (http://192.168.0.130:9810/v1/chat/completions)",
    );
    database.exec("update finding_candidate_queue set updated_at='2026-09-20 11:00:00'");
  });

  afterEach(() => database.close());

  test("dry-run discovers only the scoped paused LARM failures", async () => {
    const result = await recoverLarmProviderFailures(
      { mode: "dry-run", limit: 10, batchId: "batch-dry-run" },
      database as unknown as RecoverySqliteDatabase,
    );
    expect(result).toMatchObject({ matched: 2, requeued: 0, skipped: 0 });
    expect(result.byQueue).toEqual({ findingCandidate: 1, episodeDistiller: 1 });
    expect(database.query("select count(*) as count from distillation_queue_events").get()).toEqual(
      {
        count: 0,
      },
    );
  });

  test("write requeues atomically and records batch identity without changing routing", async () => {
    const result = await recoverLarmProviderFailures(
      { mode: "write", limit: 10, batchId: "batch-write-01" },
      database as unknown as RecoverySqliteDatabase,
    );
    expect(result).toMatchObject({ matched: 2, requeued: 2, skipped: 0 });
    const row = database
      .query(
        "select status, attempt_count, last_outcome_kind, payload from finding_candidate_queue",
      )
      .get() as Record<string, unknown>;
    expect(row).toMatchObject({
      status: "pending",
      attempt_count: 0,
      last_outcome_kind: "provider_recovery_requeued",
    });
    expect(JSON.parse(row.payload as string)).toMatchObject({ recoveryBatchId: "batch-write-01" });
    const events = database
      .query("select metadata from distillation_queue_events order by queue_name")
      .all() as Array<{ metadata: string }>;
    expect(events).toHaveLength(2);
    expect(JSON.parse(events[0]?.metadata ?? "{}")).toMatchObject({
      recoveryBatchId: "batch-write-01",
      previousErrorClass: "larm_connect",
    });
  });

  test("trace reports post-requeue state, event, and provider lease without an LLM process", async () => {
    await recoverLarmProviderFailures(
      { mode: "write", limit: 1, batchId: "batch-trace-01" },
      database as unknown as RecoverySqliteDatabase,
    );
    database.exec(
      "update finding_candidate_queue set status='completed', last_outcome_kind='completed'",
    );
    database
      .query(
        "insert into distillation_queue_events values (?, 'findingCandidate', 'finding-1', 'completed', null, '{}', ?)",
      )
      .run(crypto.randomUUID(), new Date().toISOString());
    database
      .query(
        "insert into llm_provider_leases values (?, 'local-llm-larm-qwen-agent-worker', 'findingCandidate', 'finding-1', 'released', 'completed', ?)",
      )
      .run(crypto.randomUUID(), new Date().toISOString());

    const trace = await traceLarmRecoveryBatch(
      "batch-trace-01",
      database as unknown as RecoverySqliteDatabase,
    );
    expect(trace.states).toContainEqual({
      queueName: "findingCandidate",
      status: "completed",
      outcome: "completed",
      count: 1,
    });
    expect(trace.events).toEqual([
      { eventType: "completed", count: 1 },
      { eventType: "requeued", count: 1 },
    ]);
    expect(trace.leases).toContainEqual({
      targetId: "local-llm-larm-qwen-agent-worker",
      status: "released",
      releaseReason: "completed",
      count: 1,
    });
  });

  test("trace classifies model-output failures separately from TCP and HTTP failures", async () => {
    await recoverLarmProviderFailures(
      { mode: "write", limit: 1, batchId: "batch-failure-01" },
      database as unknown as RecoverySqliteDatabase,
    );
    database.exec(`
      update finding_candidate_queue
      set status='failed', last_outcome_kind='failed',
          last_error='structured_output_incomplete finish_reason="length"'
    `);

    const trace = await traceLarmRecoveryBatch(
      "batch-failure-01",
      database as unknown as RecoverySqliteDatabase,
    );
    expect(trace.failures).toEqual([
      {
        queueName: "findingCandidate",
        status: "failed",
        reason: "structured_output_incomplete",
        count: 1,
      },
    ]);
  });
});
