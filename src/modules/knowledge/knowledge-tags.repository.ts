import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { resolveDatabaseBackendConfig } from "../../db/backend.js";
import { db } from "../../db/index.js";
import { knowledgeTagDefinitions } from "../../db/schema.js";
import { sqliteKnowledgeTagDefinitions } from "../../db/sqlite/schema.js";

export type KnowledgeTagKind =
  | "technology"
  | "change_type"
  | "retrieval_mode"
  | "domain"
  | "intent";
export type KnowledgeTagStatus = "active" | "draft" | "deprecated";

export type KnowledgeTagDefinition = {
  id: string;
  kind: KnowledgeTagKind;
  slug: string;
  label: string;
  description: string | null;
  aliases: string[];
  status: KnowledgeTagStatus;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
};

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function getSqliteCoreDatabase() {
  const { getRuntimeSqliteCoreDatabase } = await import("../../db/sqlite/runtime.js");
  return getRuntimeSqliteCoreDatabase();
}

function isSqliteBackend(): boolean {
  return resolveDatabaseBackendConfig().kind === "sqlite";
}

function toDate(value: string | Date | null | undefined): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "string") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return new Date(0);
}

function normalizeKind(value: string): KnowledgeTagKind {
  if (
    value === "change_type" ||
    value === "retrieval_mode" ||
    value === "domain" ||
    value === "intent"
  )
    return value;
  return "technology";
}

function normalizeStatus(value: string): KnowledgeTagStatus {
  if (value === "draft" || value === "deprecated") return value;
  return "active";
}

export async function listKnowledgeTagDefinitions(options?: {
  kinds?: KnowledgeTagKind[];
  statuses?: KnowledgeTagStatus[];
}): Promise<KnowledgeTagDefinition[]> {
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const rows = await sqlite.orm
      .select({
        id: sqliteKnowledgeTagDefinitions.id,
        kind: sqliteKnowledgeTagDefinitions.kind,
        slug: sqliteKnowledgeTagDefinitions.slug,
        label: sqliteKnowledgeTagDefinitions.label,
        description: sqliteKnowledgeTagDefinitions.description,
        aliases: sqliteKnowledgeTagDefinitions.aliases,
        status: sqliteKnowledgeTagDefinitions.status,
        sortOrder: sqliteKnowledgeTagDefinitions.sortOrder,
        createdAt: sqliteKnowledgeTagDefinitions.createdAt,
        updatedAt: sqliteKnowledgeTagDefinitions.updatedAt,
      })
      .from(sqliteKnowledgeTagDefinitions)
      .where(
        and(
          options?.kinds && options.kinds.length > 0
            ? inArray(sqliteKnowledgeTagDefinitions.kind, options.kinds)
            : undefined,
          options?.statuses && options.statuses.length > 0
            ? inArray(sqliteKnowledgeTagDefinitions.status, options.statuses)
            : undefined,
        ),
      )
      .orderBy(
        asc(sqliteKnowledgeTagDefinitions.kind),
        asc(sqliteKnowledgeTagDefinitions.sortOrder),
        asc(sqliteKnowledgeTagDefinitions.slug),
      );

    return rows.map((row) => ({
      id: row.id,
      kind: normalizeKind(row.kind),
      slug: row.slug,
      label: row.label,
      description: row.description,
      aliases: asStringArray(row.aliases),
      status: normalizeStatus(row.status),
      sortOrder: Number(row.sortOrder),
      createdAt: toDate(row.createdAt),
      updatedAt: toDate(row.updatedAt),
    }));
  }

  const conditions = [];
  if (options?.kinds && options.kinds.length > 0) {
    conditions.push(inArray(knowledgeTagDefinitions.kind, options.kinds));
  }
  if (options?.statuses && options.statuses.length > 0) {
    conditions.push(inArray(knowledgeTagDefinitions.status, options.statuses));
  }

  const rows = await db
    .select({
      id: knowledgeTagDefinitions.id,
      kind: knowledgeTagDefinitions.kind,
      slug: knowledgeTagDefinitions.slug,
      label: knowledgeTagDefinitions.label,
      description: knowledgeTagDefinitions.description,
      aliases: knowledgeTagDefinitions.aliases,
      status: knowledgeTagDefinitions.status,
      sortOrder: knowledgeTagDefinitions.sortOrder,
      createdAt: knowledgeTagDefinitions.createdAt,
      updatedAt: knowledgeTagDefinitions.updatedAt,
    })
    .from(knowledgeTagDefinitions)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(
      asc(knowledgeTagDefinitions.kind),
      asc(knowledgeTagDefinitions.sortOrder),
      asc(knowledgeTagDefinitions.slug),
    );

  return rows.map((row) => ({
    id: row.id,
    kind: normalizeKind(row.kind),
    slug: row.slug,
    label: row.label,
    description: row.description,
    aliases: asStringArray(row.aliases),
    status: normalizeStatus(row.status),
    sortOrder: Number(row.sortOrder),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

export async function upsertKnowledgeTagDefinitions(
  definitions: Array<{
    kind: KnowledgeTagKind;
    slug: string;
    label: string;
    description?: string;
    aliases?: string[];
    status?: KnowledgeTagStatus;
    sortOrder?: number;
  }>,
): Promise<number> {
  if (definitions.length === 0) return 0;
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    let changed = 0;
    for (const definition of definitions) {
      const aliases = (definition.aliases ?? []).map((value) => value.trim()).filter(Boolean);
      const status = definition.status ?? "active";
      const sortOrder = definition.sortOrder ?? 1000;
      const slug = definition.slug.trim();
      if (!slug) continue;

      const existing = await sqlite.orm
        .select({
          id: sqliteKnowledgeTagDefinitions.id,
          label: sqliteKnowledgeTagDefinitions.label,
          description: sqliteKnowledgeTagDefinitions.description,
          aliases: sqliteKnowledgeTagDefinitions.aliases,
          status: sqliteKnowledgeTagDefinitions.status,
          sortOrder: sqliteKnowledgeTagDefinitions.sortOrder,
        })
        .from(sqliteKnowledgeTagDefinitions)
        .where(
          and(
            eq(sqliteKnowledgeTagDefinitions.kind, definition.kind),
            eq(sqliteKnowledgeTagDefinitions.slug, slug),
          ),
        )
        .limit(1);

      const now = new Date().toISOString();
      if (existing.length === 0) {
        await sqlite.orm.insert(sqliteKnowledgeTagDefinitions).values({
          id: crypto.randomUUID(),
          kind: definition.kind,
          slug,
          label: definition.label,
          description: definition.description ?? null,
          aliases,
          status,
          sortOrder,
          createdAt: now,
          updatedAt: now,
        });
        changed += 1;
        continue;
      }

      const current = existing[0];
      const nextAliases = JSON.stringify(aliases);
      const currentAliases = JSON.stringify(asStringArray(current.aliases));
      if (
        current.label === definition.label &&
        (current.description ?? null) === (definition.description ?? null) &&
        currentAliases === nextAliases &&
        current.status === status &&
        Number(current.sortOrder) === sortOrder
      ) {
        continue;
      }

      await sqlite.orm
        .update(sqliteKnowledgeTagDefinitions)
        .set({
          label: definition.label,
          description: definition.description ?? null,
          aliases,
          status,
          sortOrder,
          updatedAt: now,
        })
        .where(eq(sqliteKnowledgeTagDefinitions.id, current.id));
      changed += 1;
    }
    return changed;
  }

  let changed = 0;

  for (const definition of definitions) {
    const aliases = (definition.aliases ?? []).map((value) => value.trim()).filter(Boolean);
    const status = definition.status ?? "active";
    const sortOrder = definition.sortOrder ?? 1000;
    const slug = definition.slug.trim();
    if (!slug) continue;

    const existing = await db
      .select({
        id: knowledgeTagDefinitions.id,
        label: knowledgeTagDefinitions.label,
        description: knowledgeTagDefinitions.description,
        aliases: knowledgeTagDefinitions.aliases,
        status: knowledgeTagDefinitions.status,
        sortOrder: knowledgeTagDefinitions.sortOrder,
      })
      .from(knowledgeTagDefinitions)
      .where(
        and(
          eq(knowledgeTagDefinitions.kind, definition.kind),
          eq(knowledgeTagDefinitions.slug, slug),
        ),
      )
      .limit(1);

    if (existing.length === 0) {
      await db.insert(knowledgeTagDefinitions).values({
        kind: definition.kind,
        slug,
        label: definition.label,
        description: definition.description ?? null,
        aliases,
        status,
        sortOrder,
      });
      changed += 1;
      continue;
    }

    const current = existing[0];
    const nextAliases = JSON.stringify(aliases);
    const currentAliases = JSON.stringify(asStringArray(current.aliases));
    if (
      current.label === definition.label &&
      (current.description ?? null) === (definition.description ?? null) &&
      currentAliases === nextAliases &&
      current.status === status &&
      Number(current.sortOrder) === sortOrder
    ) {
      continue;
    }

    await db
      .update(knowledgeTagDefinitions)
      .set({
        label: definition.label,
        description: definition.description ?? null,
        aliases,
        status,
        sortOrder,
        updatedAt: sql`now()`,
      })
      .where(eq(knowledgeTagDefinitions.id, current.id));
    changed += 1;
  }

  return changed;
}
