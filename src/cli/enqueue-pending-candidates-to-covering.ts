import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { resolveDatabaseBackendConfig } from "../db/backend.js";
import { closeDbPool, db } from "../db/index.js";
import { getRuntimeSqliteCoreDatabase } from "../db/sqlite/runtime.js";
import { appendQueueEvent } from "../modules/queue/core/events.js";

const targetKindValues = ["knowledge_candidate", "vibe_memory", "wiki_file", "web_ingest"] as const;
type TargetKind = (typeof targetKindValues)[number];
type FindingInputKind = "provided_candidate" | "source_target";

type CliOptions = {
  mode: "dry-run" | "write";
  limit: number;
  targetKinds: TargetKind[];
  forceActiveFinding: boolean;
  forceExistingCovering: boolean;
  retryFailedCovering: boolean;
};

type PendingCandidateRow = {
  find_candidate_result_id: string;
  target_state_id: string;
  candidate_index: number | string;
  title: string;
  content: string;
  origin: Record<string, unknown> | null;
  target_kind: TargetKind;
  target_key: string;
  source_uri: string;
  distillation_version: string;
  target_status: string;
  target_phase: string;
  existing_finding_job_id: string | null;
  existing_finding_status: string | null;
  existing_found_candidate_id: string | null;
  existing_covering_job_id: string | null;
  existing_covering_status: string | null;
};

function parseTargetKinds(raw: string): TargetKind[] {
  if (raw === "all") return [...targetKindValues];
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const invalid = values.filter((value) => !targetKindValues.includes(value as TargetKind));
  if (values.length === 0 || invalid.length > 0) {
    throw new Error(`--kind must be one of: all, ${targetKindValues.join(", ")}`);
  }
  return Array.from(new Set(values as TargetKind[]));
}

function inputKindForTargetKind(targetKind: TargetKind): FindingInputKind {
  return targetKind === "knowledge_candidate" ? "provided_candidate" : "source_target";
}

function priorityForTargetKind(targetKind: TargetKind): number {
  if (targetKind === "knowledge_candidate") return 90;
  if (targetKind === "web_ingest") return 80;
  if (targetKind === "wiki_file") return 70;
  return 50;
}

function sqlStringList(values: readonly string[]): string {
  return values.map((value) => `'${value.replaceAll("'", "''")}'`).join(", ");
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    mode: "dry-run",
    limit: 100,
    targetKinds: ["knowledge_candidate"],
    forceActiveFinding: false,
    forceExistingCovering: false,
    retryFailedCovering: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") {
      options.mode = "dry-run";
      continue;
    }
    if (arg === "--write") {
      options.mode = "write";
      continue;
    }
    if (arg === "--force-active-finding") {
      options.forceActiveFinding = true;
      continue;
    }
    if (arg === "--force-existing-covering") {
      options.forceExistingCovering = true;
      continue;
    }
    if (arg === "--retry-failed-covering") {
      options.retryFailedCovering = true;
      continue;
    }
    if (arg === "--kind" || arg.startsWith("--kind=")) {
      const inline = arg.match(/^--kind=(.*)$/)?.[1];
      const raw =
        inline !== undefined
          ? inline
          : (() => {
              const next = args[index + 1];
              if (!next || next.startsWith("--")) throw new Error("--kind requires a value");
              index += 1;
              return next;
            })();
      options.targetKinds = parseTargetKinds(raw);
      continue;
    }
    if (arg === "--limit" || arg.startsWith("--limit=")) {
      const inline = arg.match(/^--limit=(.*)$/)?.[1];
      const raw =
        inline !== undefined
          ? inline
          : (() => {
              const next = args[index + 1];
              if (!next || next.startsWith("--")) throw new Error("--limit requires a value");
              index += 1;
              return next;
            })();
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 1) throw new Error("--limit must be >= 1");
      options.limit = parsed;
      continue;
    }
    if (arg === "--json") {
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

async function findPendingCandidatesPostgres(
  limit: number,
  targetKinds: TargetKind[],
): Promise<PendingCandidateRow[]> {
  const targetKindSql = sqlStringList(targetKinds);
  const result = await db.execute(sql`
    select
      f.id::text as find_candidate_result_id,
      f.target_state_id::text as target_state_id,
      f.candidate_index as candidate_index,
      f.title as title,
      f.content as content,
      f.origin as origin,
      t.target_kind as target_kind,
      t.target_key as target_key,
      t.source_uri as source_uri,
      t.distillation_version as distillation_version,
      t.status as target_status,
      t.phase as target_phase,
      fq.id::text as existing_finding_job_id,
      fq.status as existing_finding_status,
      fc.id::text as existing_found_candidate_id,
      cq.id::text as existing_covering_job_id,
      cq.status as existing_covering_status
    from find_candidate_results f
    inner join distillation_target_states t on t.id = f.target_state_id
    left join cover_evidence_results c on c.id = f.id
    left join lateral (
      select ki.id
      from knowledge_items ki
      where ki.metadata ->> 'coverEvidenceResultId' = f.id::text
         or ki.metadata ->> 'sourceUri' = concat('cover-evidence-result://', f.id::text)
      limit 1
    ) k on true
    left join finding_candidate_queue fq
      on fq.input_kind = case
        when t.target_kind = 'knowledge_candidate' then 'provided_candidate'
        else 'source_target'
      end
     and fq.source_kind = t.target_kind
     and fq.source_key = t.target_key
     and fq.distillation_version = t.distillation_version
    left join found_candidates fc
      on fc.finding_job_id = fq.id
     and fc.candidate_index = f.candidate_index
    left join covering_evidence_queue cq on cq.found_candidate_id = fc.id
    where t.target_kind in (${sql.raw(targetKindSql)})
      and t.status in ('pending', 'running')
      and c.id is null
      and k.id is null
    order by greatest(f.updated_at, t.updated_at) desc, f.id asc
    limit ${limit}
  `);
  return result.rows as unknown as PendingCandidateRow[];
}

async function findPendingCandidatesSqlite(
  limit: number,
  targetKinds: TargetKind[],
): Promise<PendingCandidateRow[]> {
  const sqlite = await getRuntimeSqliteCoreDatabase();
  const targetKindSql = sqlStringList(targetKinds);
  return sqlite.db
    .query<PendingCandidateRow, [number]>(
      `
      select
        f.id as find_candidate_result_id,
        f.target_state_id as target_state_id,
        f.candidate_index as candidate_index,
        f.title as title,
        f.content as content,
        f.origin as origin,
        t.target_kind as target_kind,
        t.target_key as target_key,
        t.source_uri as source_uri,
        t.distillation_version as distillation_version,
        t.status as target_status,
        t.phase as target_phase,
        fq.id as existing_finding_job_id,
        fq.status as existing_finding_status,
        fc.id as existing_found_candidate_id,
        cq.id as existing_covering_job_id,
        cq.status as existing_covering_status
      from find_candidate_results f
      inner join distillation_target_states t on t.id = f.target_state_id
      left join cover_evidence_results c on c.id = f.id
      left join finding_candidate_queue fq
        on fq.input_kind = case
          when t.target_kind = 'knowledge_candidate' then 'provided_candidate'
          else 'source_target'
        end
       and fq.source_kind = t.target_kind
       and fq.source_key = t.target_key
       and fq.distillation_version = t.distillation_version
      left join found_candidates fc
        on fc.finding_job_id = fq.id
       and fc.candidate_index = f.candidate_index
      left join covering_evidence_queue cq on cq.found_candidate_id = fc.id
      where t.target_kind in (${targetKindSql})
        and t.status in ('pending', 'running')
        and c.id is null
        and not exists (
          select 1
          from knowledge_items ki
          where json_extract(ki.metadata, '$.coverEvidenceResultId') = f.id
             or json_extract(ki.metadata, '$.sourceUri') = 'cover-evidence-result://' || f.id
        )
      order by max(f.updated_at, t.updated_at) desc, f.id asc
      limit ?
      `,
    )
    .all(limit);
}

function normalizeRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return normalizeRecord(parsed);
    } catch {
      return {};
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function jsonb(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

async function enqueueCandidate(row: PendingCandidateRow): Promise<{
  findingJobId: string;
  foundCandidateId: string;
  coveringJobId: string;
}> {
  const now = new Date();
  const inputKind = inputKindForTargetKind(row.target_kind);
  const priority = priorityForTargetKind(row.target_kind);
  const origin = {
    ...normalizeRecord(row.origin),
    queueVersion: "v2",
    sourceKind: row.target_kind,
    sourceKey: row.target_key,
    sourceUri: row.source_uri,
    legacyTargetStateId: row.target_state_id,
    legacyFindCandidateResultId: row.find_candidate_result_id,
  };
  const payload = {
    title: row.title,
    body: row.content,
    origin,
    legacyTargetStateId: row.target_state_id,
    legacyFindCandidateResultId: row.find_candidate_result_id,
  };
  const metadata = {
    source: "enqueue_pending_candidates_to_covering",
    registeredAt: now.toISOString(),
    targetKind: row.target_kind,
    inputKind,
    legacyTargetStateId: row.target_state_id,
    legacyFindCandidateResultId: row.find_candidate_result_id,
  };
  const candidateMetadata = {
    sourceKind: row.target_kind,
    sourceKey: row.target_key,
    sourceUri: row.source_uri,
    legacyTargetStateId: row.target_state_id,
    legacyFindCandidateResultId: row.find_candidate_result_id,
  };

  const result = await db.transaction(async (tx) => {
    const findingRows = await tx.execute(sql`
      insert into finding_candidate_queue (
        input_kind,
        source_kind,
        source_key,
        source_uri,
        distillation_version,
        payload,
        metadata,
        priority,
        status,
        completed_at,
        last_outcome_kind,
        updated_at
      )
      values (
        ${inputKind},
        ${row.target_kind},
        ${row.target_key},
        ${row.source_uri},
        ${row.distillation_version},
        ${jsonb(payload)}::jsonb,
        ${jsonb(metadata)}::jsonb,
        ${priority},
        'completed',
        ${now},
        'provided_candidate_registered',
        ${now}
      )
      on conflict (input_kind, source_kind, source_key, distillation_version) do update
      set
        source_uri = excluded.source_uri,
        payload = excluded.payload,
        metadata = excluded.metadata,
        priority = ${priority},
        status = 'completed',
        completed_at = ${now},
        locked_by = null,
        locked_at = null,
        heartbeat_at = null,
        last_error = null,
        last_outcome_kind = 'provided_candidate_registered',
        updated_at = ${now}
      returning id::text as id
    `);
    const findingJobId = (findingRows.rows[0] as { id?: string } | undefined)?.id;
    if (!findingJobId) throw new Error("failed to upsert finding job");

    const foundRows = await tx.execute(sql`
      insert into found_candidates (
        finding_job_id,
        candidate_index,
        type,
        title,
        content,
        origin,
        metadata,
        updated_at
      )
      values (
        ${findingJobId}::uuid,
        ${Number(row.candidate_index)},
        null,
        ${row.title},
        ${row.content},
        ${jsonb(origin)}::jsonb,
        ${jsonb(candidateMetadata)}::jsonb,
        ${now}
      )
      on conflict (finding_job_id, candidate_index) do update
      set
        title = excluded.title,
        content = excluded.content,
        origin = excluded.origin,
        metadata = excluded.metadata,
        updated_at = ${now}
      returning id::text as id
    `);
    const foundCandidateId = (foundRows.rows[0] as { id?: string } | undefined)?.id;
    if (!foundCandidateId) throw new Error("failed to upsert found candidate");

    const coveringRows = await tx.execute(sql`
      insert into covering_evidence_queue (
        found_candidate_id,
        distillation_version,
        status,
        priority,
        provider_policy,
        payload,
        metadata,
        updated_at
      )
      values (
        ${foundCandidateId}::uuid,
        ${row.distillation_version},
        'pending',
        ${priority},
        'default',
        '{}'::jsonb,
        ${jsonb(metadata)}::jsonb,
        ${now}
      )
      on conflict (found_candidate_id) do update
      set
        status = 'pending',
        priority = ${priority},
        completed_at = null,
        locked_by = null,
        locked_at = null,
        heartbeat_at = null,
        last_error = null,
        last_outcome_kind = null,
        payload = '{}'::jsonb,
        metadata = excluded.metadata,
        updated_at = ${now}
      returning id::text as id
    `);
    const coveringJobId = (coveringRows.rows[0] as { id?: string } | undefined)?.id;
    if (!coveringJobId) throw new Error("failed to upsert covering job");

    return { findingJobId, foundCandidateId, coveringJobId };
  });

  await appendQueueEvent({
    queueName: "findingCandidate",
    queueJobId: result.findingJobId,
    eventType: "completed",
    message: "pending knowledge candidate mapped to completed finding job",
    metadata: {
      sourceKind: row.target_kind,
      sourceKey: row.target_key,
      inputKind,
      foundCandidateId: result.foundCandidateId,
      legacyFindCandidateResultId: row.find_candidate_result_id,
    },
  });
  await appendQueueEvent({
    queueName: "coveringEvidence",
    queueJobId: result.coveringJobId,
    eventType: "enqueued",
    message: "covering job enqueued from pending legacy candidate",
    metadata: {
      foundCandidateId: result.foundCandidateId,
      findingJobId: result.findingJobId,
      legacyFindCandidateResultId: row.find_candidate_result_id,
    },
  });

  return result;
}

async function enqueueCandidateSqlite(row: PendingCandidateRow): Promise<{
  findingJobId: string;
  foundCandidateId: string;
  coveringJobId: string;
}> {
  const sqlite = await getRuntimeSqliteCoreDatabase();
  const now = new Date().toISOString();
  const inputKind = inputKindForTargetKind(row.target_kind);
  const priority = priorityForTargetKind(row.target_kind);
  const origin = {
    ...normalizeRecord(row.origin),
    queueVersion: "v2",
    sourceKind: row.target_kind,
    sourceKey: row.target_key,
    sourceUri: row.source_uri,
    legacyTargetStateId: row.target_state_id,
    legacyFindCandidateResultId: row.find_candidate_result_id,
  };
  const payload = {
    title: row.title,
    body: row.content,
    origin,
    legacyTargetStateId: row.target_state_id,
    legacyFindCandidateResultId: row.find_candidate_result_id,
  };
  const metadata = {
    source: "enqueue_pending_candidates_to_covering",
    registeredAt: now,
    targetKind: row.target_kind,
    inputKind,
    legacyTargetStateId: row.target_state_id,
    legacyFindCandidateResultId: row.find_candidate_result_id,
  };
  const candidateMetadata = {
    sourceKind: row.target_kind,
    sourceKey: row.target_key,
    sourceUri: row.source_uri,
    legacyTargetStateId: row.target_state_id,
    legacyFindCandidateResultId: row.find_candidate_result_id,
  };

  sqlite.db.exec("BEGIN IMMEDIATE");
  try {
    const existingFinding = sqlite.db
      .query<{ id: string }, [string, string, string, string]>(
        `
        select id
        from finding_candidate_queue
        where input_kind = ?
          and source_kind = ?
          and source_key = ?
          and distillation_version = ?
        limit 1
        `,
      )
      .get(inputKind, row.target_kind, row.target_key, row.distillation_version);
    const findingJobId = existingFinding?.id ?? randomUUID();
    if (existingFinding) {
      sqlite.db
        .query<unknown, [string, string, string, number, string, string, string]>(
          `
          update finding_candidate_queue
          set
            source_uri = ?,
            payload = ?,
            metadata = ?,
            priority = ?,
            status = 'completed',
            completed_at = ?,
            locked_by = null,
            locked_at = null,
            heartbeat_at = null,
            last_error = null,
            last_outcome_kind = 'provided_candidate_registered',
            updated_at = ?
          where id = ?
          `,
        )
        .run(row.source_uri, jsonb(payload), jsonb(metadata), priority, now, now, findingJobId);
    } else {
      sqlite.db
        .query<
          unknown,
          [
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            number,
            string,
            string,
            string,
          ]
        >(
          `
          insert into finding_candidate_queue (
            id,
            input_kind,
            source_kind,
            source_key,
            source_uri,
            distillation_version,
            payload,
            metadata,
            priority,
            status,
            completed_at,
            last_outcome_kind,
            created_at,
            updated_at
          )
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, 'provided_candidate_registered', ?, ?)
          `,
        )
        .run(
          findingJobId,
          inputKind,
          row.target_kind,
          row.target_key,
          row.source_uri,
          row.distillation_version,
          jsonb(payload),
          jsonb(metadata),
          priority,
          now,
          now,
          now,
        );
    }

    const existingFound = sqlite.db
      .query<{ id: string }, [string, number]>(
        `
        select id
        from found_candidates
        where finding_job_id = ?
          and candidate_index = ?
        limit 1
        `,
      )
      .get(findingJobId, Number(row.candidate_index));
    const foundCandidateId = existingFound?.id ?? randomUUID();
    if (existingFound) {
      sqlite.db
        .query<unknown, [string, string, string, string, string, string]>(
          `
          update found_candidates
          set
            title = ?,
            content = ?,
            origin = ?,
            metadata = ?,
            updated_at = ?
          where id = ?
          `,
        )
        .run(
          row.title,
          row.content,
          jsonb(origin),
          jsonb(candidateMetadata),
          now,
          foundCandidateId,
        );
    } else {
      sqlite.db
        .query<unknown, [string, string, number, string, string, string, string, string, string]>(
          `
          insert into found_candidates (
            id,
            finding_job_id,
            candidate_index,
            type,
            title,
            content,
            origin,
            metadata,
            created_at,
            updated_at
          )
          values (?, ?, ?, null, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          foundCandidateId,
          findingJobId,
          Number(row.candidate_index),
          row.title,
          row.content,
          jsonb(origin),
          jsonb(candidateMetadata),
          now,
          now,
        );
    }

    const existingCovering = sqlite.db
      .query<{ id: string }, [string]>(
        `
        select id
        from covering_evidence_queue
        where found_candidate_id = ?
        limit 1
        `,
      )
      .get(foundCandidateId);
    const coveringJobId = existingCovering?.id ?? randomUUID();
    if (existingCovering) {
      sqlite.db
        .query<unknown, [number, string, string, string]>(
          `
          update covering_evidence_queue
          set
            status = 'pending',
            priority = ?,
            completed_at = null,
            locked_by = null,
            locked_at = null,
            heartbeat_at = null,
            last_error = null,
            last_outcome_kind = null,
            payload = '{}',
            metadata = ?,
            updated_at = ?
          where id = ?
          `,
        )
        .run(priority, jsonb(metadata), now, coveringJobId);
    } else {
      sqlite.db
        .query<unknown, [string, string, string, number, string, string, string]>(
          `
          insert into covering_evidence_queue (
            id,
            found_candidate_id,
            distillation_version,
            status,
            priority,
            provider_policy,
            payload,
            metadata,
            created_at,
            updated_at
          )
          values (?, ?, ?, 'pending', ?, 'default', '{}', ?, ?, ?)
          `,
        )
        .run(
          coveringJobId,
          foundCandidateId,
          row.distillation_version,
          priority,
          jsonb(metadata),
          now,
          now,
        );
    }

    sqlite.db.exec("COMMIT");
    const result = { findingJobId, foundCandidateId, coveringJobId };

    await appendQueueEvent({
      queueName: "findingCandidate",
      queueJobId: result.findingJobId,
      eventType: "completed",
      message: "pending knowledge candidate mapped to completed finding job",
      metadata: {
        sourceKind: row.target_kind,
        sourceKey: row.target_key,
        inputKind,
        foundCandidateId: result.foundCandidateId,
        legacyFindCandidateResultId: row.find_candidate_result_id,
      },
    });
    await appendQueueEvent({
      queueName: "coveringEvidence",
      queueJobId: result.coveringJobId,
      eventType: "enqueued",
      message: "covering job enqueued from pending legacy candidate",
      metadata: {
        foundCandidateId: result.foundCandidateId,
        findingJobId: result.findingJobId,
        legacyFindCandidateResultId: row.find_candidate_result_id,
      },
    });

    return result;
  } catch (error) {
    sqlite.db.exec("ROLLBACK");
    throw error;
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const backend = resolveDatabaseBackendConfig();
  const rows =
    backend.kind === "sqlite"
      ? await findPendingCandidatesSqlite(options.limit, options.targetKinds)
      : await findPendingCandidatesPostgres(options.limit, options.targetKinds);
  const activeFindingStatuses = new Set(["pending", "running"]);
  const report = {
    mode: options.mode,
    limit: options.limit,
    targetKinds: options.targetKinds,
    scanned: rows.length,
    wouldEnqueue: 0,
    enqueued: 0,
    skippedActiveFinding: 0,
    skippedExistingCovering: 0,
    items: [] as Array<Record<string, unknown>>,
  };

  for (const row of rows) {
    const hasActiveFinding =
      row.existing_finding_status !== null &&
      activeFindingStatuses.has(row.existing_finding_status);
    if (hasActiveFinding && !options.forceActiveFinding) {
      report.skippedActiveFinding += 1;
      report.items.push({
        findCandidateResultId: row.find_candidate_result_id,
        targetStateId: row.target_state_id,
        targetKind: row.target_kind,
        targetKey: row.target_key,
        action: "skipped_active_finding",
        existingFindingJobId: row.existing_finding_job_id,
        existingFindingStatus: row.existing_finding_status,
      });
      continue;
    }

    const canRetryFailedCovering =
      options.retryFailedCovering && row.existing_covering_status === "failed";
    if (row.existing_covering_job_id && !options.forceExistingCovering && !canRetryFailedCovering) {
      report.skippedExistingCovering += 1;
      report.items.push({
        findCandidateResultId: row.find_candidate_result_id,
        targetStateId: row.target_state_id,
        targetKind: row.target_kind,
        targetKey: row.target_key,
        action: "skipped_existing_covering",
        existingCoveringJobId: row.existing_covering_job_id,
        existingCoveringStatus: row.existing_covering_status,
      });
      continue;
    }

    report.wouldEnqueue += 1;
    if (options.mode === "dry-run") {
      report.items.push({
        findCandidateResultId: row.find_candidate_result_id,
        targetStateId: row.target_state_id,
        targetKind: row.target_kind,
        targetKey: row.target_key,
        action: "would_enqueue",
        existingFindingJobId: row.existing_finding_job_id,
        existingFindingStatus: row.existing_finding_status,
      });
      continue;
    }

    const result =
      backend.kind === "sqlite" ? await enqueueCandidateSqlite(row) : await enqueueCandidate(row);
    report.enqueued += 1;
    report.items.push({
      findCandidateResultId: row.find_candidate_result_id,
      targetStateId: row.target_state_id,
      targetKind: row.target_kind,
      targetKey: row.target_key,
      action: "enqueued",
      ...result,
    });
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbPool();
  });
