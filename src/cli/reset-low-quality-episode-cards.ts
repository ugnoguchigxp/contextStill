#!/usr/bin/env bun

import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { closeDbPool } from "../db/index.js";
import { resolveDatabaseBackendConfig } from "../db/backend.js";
import { getRuntimeSqliteCoreDatabase } from "../db/sqlite/runtime.js";
import { appendQueueEvent } from "../modules/queue/core/events.js";

type Options = {
  write: boolean;
  backup: boolean;
  limit: number;
  json: boolean;
  reason: string;
};

type TargetRow = {
  episode_id: string;
  title: string;
  source_key: string;
  job_id: string | null;
  job_status: string | null;
};

type TargetJob = {
  id: string;
  sourceKey: string;
  status: string;
  episodeIds: string[];
};

type ResetResult = {
  write: boolean;
  backupPath: string | null;
  scanned: number;
  deletedEpisodes: number;
  requeuedJobs: number;
  skippedRunningJobs: number;
  items: Array<{ id: string; title: string; sourceKey: string; jobId: string | null }>;
  jobs: TargetJob[];
};

const RESET_VERSION = "episode-quality-reset-v1";
const FALLBACK_ACTION = "主要な実施内容は source metadata からは特定できません。";
const TEMPLATE_OUTCOME_PATTERNS = [
  "% は source 時点で主要な判断や修正が進んだが、追加確認事項が残った。",
  "% は source 時点で目的範囲の実装、判断、または検証が完了した。",
  "% では失敗原因または避けるべき approach が特定された。",
  "% の結果は source から部分的に確認できるが、最終状態は明確ではない。",
];

function readArgValue(args: string[], index: number, name: string): string {
  const inline = args[index]?.match(new RegExp(`^${name}=(.*)$`))?.[1];
  if (inline !== undefined) return inline;
  const next = args[index + 1];
  if (!next || next.startsWith("--")) throw new Error(`${name} requires a value`);
  return next;
}

export function parseArgs(args: string[]): Options {
  const options: Options = {
    write: false,
    backup: false,
    limit: 1000,
    json: false,
    reason: "low-quality EpisodeCards reset for source-ref re-distillation",
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--write") {
      options.write = true;
    } else if (arg === "--dry-run") {
      options.write = false;
    } else if (arg === "--backup") {
      options.backup = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--limit" || arg.startsWith("--limit=")) {
      const raw = readArgValue(args, index, "--limit");
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error("--limit must be a positive integer");
      }
      options.limit = parsed;
      if (arg === "--limit") index += 1;
    } else if (arg === "--reason" || arg.startsWith("--reason=")) {
      options.reason = readArgValue(args, index, "--reason").trim();
      if (!options.reason) throw new Error("--reason must not be empty");
      if (arg === "--reason") index += 1;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage: CONTEXT_STILL_DB_BACKEND=sqlite bun run src/cli/reset-low-quality-episode-cards.ts [--dry-run|--write] [--backup] [--limit N] [--reason TEXT] [--json]\n",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function sqliteStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function defaultBackupPath(sourcePath: string): string {
  const parsed = path.parse(sourcePath);
  return path.join(
    parsed.dir,
    "backups",
    `${parsed.name}.before-episode-reset-${timestamp()}${parsed.ext || ".sqlite"}`,
  );
}

async function backupSqliteDatabase(): Promise<string> {
  const config = resolveDatabaseBackendConfig({ backend: "sqlite" });
  if (!config.sqlitePath) throw new Error("SQLite backend path could not be resolved");
  const source = path.resolve(config.sqlitePath);
  const sourceStat = await stat(source).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!sourceStat?.isFile()) throw new Error(`SQLite source database not found: ${source}`);
  const output = path.resolve(defaultBackupPath(source));
  await mkdir(path.dirname(output), { recursive: true });
  const sqlite = await getRuntimeSqliteCoreDatabase();
  sqlite.db.exec("PRAGMA wal_checkpoint(PASSIVE);");
  sqlite.db.exec(`VACUUM INTO ${sqliteStringLiteral(output)};`);
  return output;
}

function targetWhereClause(): string {
  return `
    json_extract(e.metadata, '$.source') = 'episodeDistiller'
    and (
      e.action = ?
      or e.outcome like ?
      or e.outcome like ?
      or e.outcome like ?
      or e.outcome like ?
    )
  `;
}

function targetParams(): [string, string, string, string, string] {
  return [FALLBACK_ACTION, ...TEMPLATE_OUTCOME_PATTERNS] as [
    string,
    string,
    string,
    string,
    string,
  ];
}

function groupJobs(rows: TargetRow[]): TargetJob[] {
  const byJob = new Map<string, TargetJob>();
  for (const row of rows) {
    if (!row.job_id || !row.job_status) continue;
    const existing = byJob.get(row.job_id);
    if (existing) {
      existing.episodeIds.push(row.episode_id);
      continue;
    }
    byJob.set(row.job_id, {
      id: row.job_id,
      sourceKey: row.source_key,
      status: row.job_status,
      episodeIds: [row.episode_id],
    });
  }
  return [...byJob.values()];
}

export async function resetLowQualityEpisodeCards(options: Options): Promise<ResetResult> {
  const sqlite = await getRuntimeSqliteCoreDatabase();
  const rows = sqlite.db
    .query<TargetRow, [string, string, string, string, string, number]>(
      `
      select
        e.id as episode_id,
        e.title,
        e.source_key,
        q.id as job_id,
        q.status as job_status
      from episode_cards e
      left join episode_refs er
        on er.episode_card_id = e.id
       and er.ref_kind = 'vibe_memory'
      left join episode_distiller_queue q
        on q.source_key = er.ref_value
       and q.source_kind = 'vibe_memory'
      where ${targetWhereClause()}
      order by e.created_at asc, e.id asc
      limit ?
    `,
    )
    .all(...targetParams(), options.limit);
  const jobs = groupJobs(rows);
  const runningJobs = new Set(jobs.filter((job) => job.status === "running").map((job) => job.id));
  const deletableRows = rows.filter((row) => !row.job_id || !runningJobs.has(row.job_id));
  const requeueJobs = jobs.filter((job) => job.status !== "running");

  let backupPath: string | null = null;
  if (options.write && options.backup && deletableRows.length > 0) {
    backupPath = await backupSqliteDatabase();
  }

  if (options.write && deletableRows.length > 0) {
    const now = new Date().toISOString();
    sqlite.db.query("BEGIN IMMEDIATE").run();
    try {
      const deleteRefs = sqlite.db.query("delete from episode_refs where episode_card_id = ?");
      const deleteFts = sqlite.db.query("delete from episode_cards_fts where id = ?");
      const deleteEpisode = sqlite.db.query("delete from episode_cards where id = ?");
      const updateJob = sqlite.db.query(
        `
        update episode_distiller_queue
        set status = 'pending',
            priority = max(priority, 95),
            attempt_count = 0,
            next_run_at = null,
            completed_at = null,
            locked_by = null,
            locked_at = null,
            heartbeat_at = null,
            last_error = ?,
            last_outcome_kind = 'episode_quality_reset_requeued',
            metadata = json_patch(coalesce(nullif(metadata, ''), '{}'), ?),
            updated_at = ?
        where id = ?
          and status <> 'running'
      `,
      );
      for (const row of deletableRows) {
        deleteRefs.run(row.episode_id);
        deleteFts.run(row.episode_id);
        deleteEpisode.run(row.episode_id);
      }
      for (const job of requeueJobs) {
        updateJob.run(
          options.reason,
          JSON.stringify({
            episodeDistillerQualityReset: {
              version: RESET_VERSION,
              resetAt: now,
              reason: options.reason,
              deletedEpisodeIds: job.episodeIds,
              previousStatus: job.status,
              targetQualityScore: 85,
            },
          }),
          now,
          job.id,
        );
      }
      sqlite.db.query("COMMIT").run();
    } catch (error) {
      sqlite.db.query("ROLLBACK").run();
      throw error;
    }

    for (const job of requeueJobs) {
      await appendQueueEvent({
        queueName: "episodeDistiller",
        queueJobId: job.id,
        eventType: "retried",
        message: "episode distiller low-quality cards reset and requeued",
        metadata: {
          reason: options.reason,
          deletedEpisodeIds: job.episodeIds,
          previousStatus: job.status,
          targetQualityScore: 85,
        },
      });
    }
  }

  return {
    write: options.write,
    backupPath,
    scanned: rows.length,
    deletedEpisodes: options.write ? deletableRows.length : 0,
    requeuedJobs: options.write ? requeueJobs.length : 0,
    skippedRunningJobs: runningJobs.size,
    items: rows.map((row) => ({
      id: row.episode_id,
      title: row.title,
      sourceKey: row.source_key,
      jobId: row.job_id,
    })),
    jobs,
  };
}

if (import.meta.main) {
  resetLowQualityEpisodeCards(parseArgs(process.argv.slice(2)))
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    })
    .finally(async () => {
      await closeDbPool();
    });
}
