import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { knowledgeTagDefinitions } from "../../db/schema.js";

export type KnowledgeTagKind = "technology" | "change_type" | "retrieval_mode" | "domain";
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

function normalizeKind(value: string): KnowledgeTagKind {
  if (value === "change_type" || value === "retrieval_mode" || value === "domain") return value;
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
