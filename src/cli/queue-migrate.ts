import { createHash } from "node:crypto";
import { closeDbPool, db } from "../db/index.js";
import { sql } from "drizzle-orm";

type CliOptions = {
  dryRun: boolean;
  write: boolean;
  backup: boolean;
};

type LegacyCounts = {
  targetStates: number;
  findResults: number;
  coverResults: number;
};

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    dryRun: false,
    write: false,
    backup: false,
  };
  for (const arg of args) {
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--write") options.write = true;
    else if (arg === "--backup") options.backup = true;
    else if (arg === "--json") {
      // json only
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!options.dryRun && !options.write) {
    throw new Error("Specify --dry-run or --write");
  }
  return options;
}

async function tableExists(tableName: string): Promise<boolean> {
  const result = await db.execute(sql`select to_regclass(${`public.${tableName}`}) as regclass`);
  const row = result.rows[0] as { regclass?: string | null } | undefined;
  return Boolean(row?.regclass);
}

async function readLegacyCounts(): Promise<LegacyCounts> {
  const result = await db.execute(sql`
    select
      (select count(*)::int from distillation_target_states) as target_states,
      (select count(*)::int from find_candidate_results) as find_results,
      (select count(*)::int from cover_evidence_results) as cover_results
  `);
  const row = result.rows[0] as
    | { target_states?: number; find_results?: number; cover_results?: number }
    | undefined;
  return {
    targetStates: Number(row?.target_states ?? 0),
    findResults: Number(row?.find_results ?? 0),
    coverResults: Number(row?.cover_results ?? 0),
  };
}

function makeIdempotencyKey(input: {
  targetStateId: string | null;
  findCandidateResultId: string | null;
  coverEvidenceResultId: string | null;
  targetKind: string | null;
  targetKey: string | null;
  distillationVersion: string | null;
}): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

async function writeMigrationMap(runId: string): Promise<{ mapped: number }> {
  const rows = await db.execute(sql`
    select
      t.id as target_state_id,
      t.target_kind,
      t.target_key,
      t.distillation_version,
      f.id as find_candidate_result_id,
      c.id as cover_evidence_result_id
    from distillation_target_states t
    left join find_candidate_results f on f.target_state_id = t.id
    left join cover_evidence_results c on c.id = f.id
  `);

  let mapped = 0;
  for (const row of rows.rows as Array<Record<string, unknown>>) {
    const targetStateId = typeof row.target_state_id === "string" ? row.target_state_id : null;
    const findCandidateResultId =
      typeof row.find_candidate_result_id === "string" ? row.find_candidate_result_id : null;
    const coverEvidenceResultId =
      typeof row.cover_evidence_result_id === "string" ? row.cover_evidence_result_id : null;
    const targetKind = typeof row.target_kind === "string" ? row.target_kind : null;
    const targetKey = typeof row.target_key === "string" ? row.target_key : null;
    const distillationVersion =
      typeof row.distillation_version === "string" ? row.distillation_version : null;
    const idempotencyKey = makeIdempotencyKey({
      targetStateId,
      findCandidateResultId,
      coverEvidenceResultId,
      targetKind,
      targetKey,
      distillationVersion,
    });

    await db.execute(sql`
      insert into distillation_queue_migration_map (
        idempotency_key,
        legacy_target_state_id,
        legacy_find_candidate_result_id,
        legacy_cover_evidence_result_id,
        legacy_target_kind,
        legacy_target_key,
        distillation_version,
        migration_run_id,
        migration_status,
        metadata,
        created_at,
        updated_at
      )
      values (
        ${idempotencyKey},
        ${targetStateId},
        ${findCandidateResultId},
        ${coverEvidenceResultId},
        ${targetKind},
        ${targetKey},
        ${distillationVersion},
        ${runId},
        'migrated',
        '{}'::jsonb,
        now(),
        now()
      )
      on conflict (idempotency_key) do update
      set
        legacy_target_state_id = excluded.legacy_target_state_id,
        legacy_find_candidate_result_id = excluded.legacy_find_candidate_result_id,
        legacy_cover_evidence_result_id = excluded.legacy_cover_evidence_result_id,
        legacy_target_kind = excluded.legacy_target_kind,
        legacy_target_key = excluded.legacy_target_key,
        distillation_version = excluded.distillation_version,
        migration_run_id = excluded.migration_run_id,
        migration_status = excluded.migration_status,
        updated_at = now()
    `);
    mapped += 1;
  }

  return { mapped };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const hasQueueSchema = await tableExists("distillation_queue_migration_map");
  const legacy = await readLegacyCounts();

  const report: Record<string, unknown> = {
    mode: options.write ? "write" : "dry-run",
    backupRequested: options.backup,
    schemaReady: hasQueueSchema,
    legacy,
    projected: {
      migrationMapRows: legacy.targetStates,
    },
  };

  if (options.write) {
    if (!hasQueueSchema) {
      throw new Error("Queue schema is not ready. Run db:migrate first.");
    }
    const runId = `queue-migrate:${new Date().toISOString()}`;
    const writeResult = await writeMigrationMap(runId);
    report.runId = runId;
    report.written = writeResult;
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
