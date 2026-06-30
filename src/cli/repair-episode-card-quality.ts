#!/usr/bin/env bun

import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { resolveDatabaseBackendConfig } from "../db/backend.js";
import { getRuntimeSqliteCoreDatabase } from "../db/sqlite/runtime.js";

type Options = {
  write: boolean;
  backup: boolean;
  limit: number;
  json: boolean;
};

type EpisodeRow = {
  rowid: number;
  id: string;
  title: string;
  situation: string;
  observations: string;
  action: string;
  outcome: string;
  lesson: string;
  anti_applicability: string;
  metadata: string;
};

type RepairItem = {
  id: string;
  title: string;
  changedFields: string[];
};

type RepairResult = {
  write: boolean;
  backupPath: string | null;
  scanned: number;
  changed: number;
  changedByField: Record<string, number>;
  items: RepairItem[];
};

const REPAIR_VERSION = "episode-card-quality-v1";

function readArgValue(args: string[], index: number, name: string): string {
  const inline = args[index]?.match(new RegExp(`^${name}=(.*)$`))?.[1];
  if (inline !== undefined) return inline;
  const next = args[index + 1];
  if (!next || next.startsWith("--")) throw new Error(`${name} requires a value`);
  return next;
}

export function parseArgs(args: string[]): Options {
  const options: Options = { write: false, backup: false, limit: 1000, json: false };
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
      if (!Number.isInteger(parsed) || parsed < 1)
        throw new Error("--limit must be a positive integer");
      options.limit = parsed;
      if (arg === "--limit") index += 1;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage: CONTEXT_STILL_DB_BACKEND=sqlite bun run src/cli/repair-episode-card-quality.ts [--dry-run|--write] [--backup] [--limit N] [--json]\n",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function parseRecord(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function stableJson(value: unknown): string {
  return JSON.stringify(value ?? {});
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
    `${parsed.name}.before-episode-quality-${timestamp()}${parsed.ext || ".sqlite"}`,
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

function stripLegacyOpenLoops(action: string): string {
  return action
    .replace(/\n\nsource 時点の未解決事項:\n[\s\S]*$/u, "")
    .replace(/^source 時点の未解決事項:\n[\s\S]*$/u, "")
    .replace(/^失敗した、または避けたアプローチ:\n/, "")
    .trim();
}

function deriveOutcome(canonical: Record<string, unknown>, title: string): string {
  const explicit = asString(canonical.outcome);
  if (explicit) return explicit;
  const outcomeKind = asString(canonical.outcomeKind);
  const openLoops = asStringArray(canonical.openLoops);
  if (outcomeKind === "mixed" || openLoops.length > 0) {
    return `${title} は source 時点で主要な判断や修正が進んだが、追加確認事項が残った。`;
  }
  if (outcomeKind === "failure") {
    return `${title} では失敗原因または避けるべき approach が特定された。`;
  }
  if (outcomeKind === "success") {
    return `${title} は source 時点で目的範囲の実装、判断、または検証が完了した。`;
  }
  return `${title} の結果は source から部分的に確認できるが、最終状態は明確ではない。`;
}

function repairRow(row: EpisodeRow): {
  changedFields: string[];
  next: Pick<EpisodeRow, "situation" | "action" | "outcome" | "anti_applicability" | "metadata">;
} | null {
  const metadata = parseRecord(row.metadata);
  const episodeDistillation = asRecord(metadata.episodeDistillation);
  const canonical = asRecord(episodeDistillation.canonical);
  if (Object.keys(canonical).length === 0) return null;

  const context = asString(canonical.context);
  const actionTaken = asString(canonical.actionTaken);
  const failedApproach = asString(canonical.failedApproach);
  const openLoops = asStringArray(canonical.openLoops);
  const currentActionWithoutOpenLoops = stripLegacyOpenLoops(row.action);

  const nextSituation = context || row.situation.replace(/\n\nIntent:\n[\s\S]*$/u, "").trim();
  const nextAction =
    actionTaken ||
    failedApproach ||
    currentActionWithoutOpenLoops ||
    "主要な実施内容は source metadata からは特定できません。";
  const nextOutcome = deriveOutcome(canonical, row.title);

  const antiApplicability = parseRecord(row.anti_applicability);
  const nextAntiApplicability = {
    ...antiApplicability,
    ...(openLoops.length > 0 ? { openLoops } : {}),
  };
  const nextMetadata = {
    ...metadata,
    episodeDistillation: {
      ...episodeDistillation,
      canonical: {
        ...canonical,
        actionTaken: nextAction,
        outcome: nextOutcome,
      },
      repair: {
        version: REPAIR_VERSION,
      },
    },
  };

  const next = {
    situation: nextSituation,
    action: nextAction,
    outcome: nextOutcome,
    anti_applicability: stableJson(nextAntiApplicability),
    metadata: stableJson(nextMetadata),
  };
  const changedFields = Object.entries(next)
    .filter(([key, value]) => row[key as keyof typeof next] !== value)
    .map(([key]) => key);
  return changedFields.length > 0 ? { changedFields, next } : null;
}

export async function repairEpisodeCardQuality(options: Options): Promise<RepairResult> {
  const sqlite = await getRuntimeSqliteCoreDatabase();
  const rows = sqlite.db
    .query<EpisodeRow, [number]>(
      `
      select rowid, id, title, situation, observations, action, outcome, lesson,
             anti_applicability, metadata
      from episode_cards
      where json_extract(metadata, '$.source') = 'episodeDistiller'
      order by created_at asc
      limit ?
    `,
    )
    .all(options.limit);
  const changes = rows
    .map((row) => ({ row, repair: repairRow(row) }))
    .filter(
      (item): item is { row: EpisodeRow; repair: NonNullable<ReturnType<typeof repairRow>> } =>
        Boolean(item.repair),
    );

  let backupPath: string | null = null;
  if (options.write && options.backup && changes.length > 0) {
    backupPath = await backupSqliteDatabase();
  }

  if (options.write && changes.length > 0) {
    sqlite.db.query("BEGIN IMMEDIATE").run();
    try {
      const updateEpisode = sqlite.db.query(
        `
        update episode_cards
        set situation = ?,
            action = ?,
            outcome = ?,
            anti_applicability = ?,
            metadata = ?,
            updated_at = ?
        where id = ?
      `,
      );
      const deleteFts = sqlite.db.query("delete from episode_cards_fts where id = ?");
      const insertFts = sqlite.db.query(
        `
        insert into episode_cards_fts(rowid, id, title, situation, observations, action, outcome, lesson)
        values (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      );
      const now = new Date().toISOString();
      for (const { row, repair } of changes) {
        updateEpisode.run(
          repair.next.situation,
          repair.next.action,
          repair.next.outcome,
          repair.next.anti_applicability,
          repair.next.metadata,
          now,
          row.id,
        );
        deleteFts.run(row.id);
        insertFts.run(
          row.rowid,
          row.id,
          row.title,
          repair.next.situation,
          row.observations,
          repair.next.action,
          repair.next.outcome,
          row.lesson,
        );
      }
      sqlite.db.query("COMMIT").run();
    } catch (error) {
      sqlite.db.query("ROLLBACK").run();
      throw error;
    }
  }

  const changedByField: Record<string, number> = {};
  for (const { repair } of changes) {
    for (const field of repair.changedFields) {
      changedByField[field] = (changedByField[field] ?? 0) + 1;
    }
  }

  return {
    write: options.write,
    backupPath,
    scanned: rows.length,
    changed: changes.length,
    changedByField,
    items: changes.map(({ row, repair }) => ({
      id: row.id,
      title: row.title,
      changedFields: repair.changedFields,
    })),
  };
}

if (import.meta.main) {
  repairEpisodeCardQuality(parseArgs(process.argv.slice(2)))
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
