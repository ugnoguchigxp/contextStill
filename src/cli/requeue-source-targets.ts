import { sql } from "drizzle-orm";
import { closeDbPool, db } from "../db/index.js";
import { enqueueFindingJob } from "../modules/queue/core/worker.js";

const supportedKinds = ["vibe_memory", "wiki_file"] as const;

type SourceTargetKind = (typeof supportedKinds)[number];

type CliOptions = {
  mode: "dry-run" | "write";
  kinds: SourceTargetKind[];
  limit: number;
  forceActive: boolean;
};

type CandidateRow = {
  target_state_id: string;
  target_kind: SourceTargetKind;
  target_key: string;
  source_uri: string;
  distillation_version: string;
  target_status: string;
  target_phase: string;
  find_candidate_results: number | string;
  existing_finding_job_id: string | null;
  existing_finding_status: string | null;
};

function parseKinds(raw: string): SourceTargetKind[] {
  if (raw === "all") return [...supportedKinds];
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const invalid = values.filter(
    (value): value is string => !supportedKinds.includes(value as SourceTargetKind),
  );
  if (invalid.length > 0 || values.length === 0) {
    throw new Error(`--kind must be one of: all, ${supportedKinds.join(", ")}`);
  }
  return Array.from(new Set(values as SourceTargetKind[]));
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    mode: "dry-run",
    kinds: [...supportedKinds],
    limit: 100,
    forceActive: false,
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
    if (arg === "--force-active") {
      options.forceActive = true;
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
      options.kinds = parseKinds(raw);
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

async function findSourceTargets(options: CliOptions): Promise<CandidateRow[]> {
  const kindList = options.kinds.map((kind) => `'${kind}'`).join(", ");
  const result = await db.execute(sql`
    select
      t.id::text as target_state_id,
      t.target_kind as target_kind,
      t.target_key as target_key,
      t.source_uri as source_uri,
      t.distillation_version as distillation_version,
      t.status as target_status,
      t.phase as target_phase,
      count(f.id)::int as find_candidate_results,
      fq.id::text as existing_finding_job_id,
      fq.status as existing_finding_status
    from distillation_target_states t
    left join find_candidate_results f on f.target_state_id = t.id
    left join finding_candidate_queue fq
      on fq.input_kind = 'source_target'
     and fq.source_kind = t.target_kind
     and fq.source_key = t.target_key
     and fq.distillation_version = t.distillation_version
    where t.target_kind in (${sql.raw(kindList)})
      and t.status in ('pending', 'running')
      and t.phase in ('selected', 'finding_candidate')
      and not exists (
        select 1
        from find_candidate_results fx
        inner join cover_evidence_results cx on cx.id = fx.id
        where fx.target_state_id = t.id
      )
    group by
      t.id,
      t.target_kind,
      t.target_key,
      t.source_uri,
      t.distillation_version,
      t.status,
      t.phase,
      t.updated_at,
      fq.id,
      fq.status
    order by t.updated_at desc, t.id asc
    limit ${options.limit}
  `);
  return result.rows as unknown as CandidateRow[];
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const rows = await findSourceTargets(options);
  const activeStatuses = new Set(["pending", "running"]);
  const report = {
    mode: options.mode,
    kinds: options.kinds,
    limit: options.limit,
    scanned: rows.length,
    wouldEnqueue: 0,
    enqueued: 0,
    skippedActiveQueue: 0,
    skippedMissingSource: 0,
    items: [] as Array<Record<string, unknown>>,
  };

  for (const row of rows) {
    const hasActiveQueue =
      row.existing_finding_status !== null && activeStatuses.has(row.existing_finding_status);
    if (hasActiveQueue && !options.forceActive) {
      report.skippedActiveQueue += 1;
      report.items.push({
        targetStateId: row.target_state_id,
        targetKind: row.target_kind,
        targetKey: row.target_key,
        action: "skipped_active_queue",
        existingFindingJobId: row.existing_finding_job_id,
        existingFindingStatus: row.existing_finding_status,
      });
      continue;
    }

    report.wouldEnqueue += 1;
    if (options.mode === "dry-run") {
      report.items.push({
        targetStateId: row.target_state_id,
        targetKind: row.target_kind,
        targetKey: row.target_key,
        action: "would_enqueue",
        existingFindingJobId: row.existing_finding_job_id,
        existingFindingStatus: row.existing_finding_status,
        findCandidateResults: Number(row.find_candidate_results),
      });
      continue;
    }

    const job = await enqueueFindingJob({
      inputKind: "source_target",
      sourceKind: row.target_kind,
      sourceKey: row.target_key,
      sourceUri: row.source_uri,
      distillationVersion: row.distillation_version,
      metadata: {
        sourceTargetRequeue: true,
        legacyTargetStateId: row.target_state_id,
        legacyTargetStatus: row.target_status,
        legacyTargetPhase: row.target_phase,
        findCandidateResults: Number(row.find_candidate_results),
      },
    });

    if (!job) {
      report.skippedMissingSource += 1;
      report.items.push({
        targetStateId: row.target_state_id,
        targetKind: row.target_kind,
        targetKey: row.target_key,
        action: "skipped_missing_source",
      });
      continue;
    }

    report.enqueued += 1;
    report.items.push({
      targetStateId: row.target_state_id,
      targetKind: row.target_kind,
      targetKey: row.target_key,
      action: "enqueued",
      findingJobId: job.id,
      findingStatus: job.status,
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
