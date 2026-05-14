import { createHash } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { db } from "../../../src/db/index.js";
import { evidenceFragments, evidenceSources } from "../../../src/db/schema.js";
import { embedOne } from "../../../src/modules/embedding/embedding.service.js";

export type EvidenceSourceWriteInput = {
  sourceKind: string;
  uri: string;
  title?: string | null;
  contentHash?: string;
  metadata?: Record<string, unknown>;
};

export type EvidenceFragmentWriteInput = {
  sourceId: string;
  locator: string;
  content: string;
  metadata?: Record<string, unknown>;
};

function defaultHash(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export async function listEvidenceSources(limit: number) {
  return db
    .select({
      id: evidenceSources.id,
      sourceKind: evidenceSources.sourceKind,
      uri: evidenceSources.uri,
      title: evidenceSources.title,
      contentHash: evidenceSources.contentHash,
      metadata: evidenceSources.metadata,
      createdAt: evidenceSources.createdAt,
      updatedAt: evidenceSources.updatedAt,
    })
    .from(evidenceSources)
    .orderBy(desc(evidenceSources.updatedAt))
    .limit(limit);
}

export async function listEvidenceFragments(limit: number) {
  return db
    .select({
      id: evidenceFragments.id,
      sourceId: evidenceFragments.sourceId,
      sourceUri: evidenceSources.uri,
      locator: evidenceFragments.locator,
      content: evidenceFragments.content,
      metadata: evidenceFragments.metadata,
      createdAt: evidenceFragments.createdAt,
    })
    .from(evidenceFragments)
    .innerJoin(evidenceSources, eq(evidenceSources.id, evidenceFragments.sourceId))
    .orderBy(desc(evidenceFragments.createdAt))
    .limit(limit);
}

export async function createEvidenceSource(input: EvidenceSourceWriteInput) {
  const [inserted] = await db
    .insert(evidenceSources)
    .values({
      sourceKind: input.sourceKind,
      uri: input.uri,
      title: input.title ?? null,
      contentHash: input.contentHash || defaultHash(`${input.sourceKind}\n${input.uri}`),
      metadata: input.metadata ?? {},
    })
    .returning({ id: evidenceSources.id });
  return inserted;
}

export async function updateEvidenceSource(id: string, input: EvidenceSourceWriteInput) {
  const [updated] = await db
    .update(evidenceSources)
    .set({
      sourceKind: input.sourceKind,
      uri: input.uri,
      title: input.title ?? null,
      contentHash: input.contentHash || defaultHash(`${input.sourceKind}\n${input.uri}`),
      metadata: input.metadata ?? {},
      updatedAt: new Date(),
    })
    .where(eq(evidenceSources.id, id))
    .returning({ id: evidenceSources.id });
  return updated ?? null;
}

export async function deleteEvidenceSource(id: string) {
  const [deleted] = await db
    .delete(evidenceSources)
    .where(eq(evidenceSources.id, id))
    .returning({ id: evidenceSources.id });
  return deleted ?? null;
}

async function tryEmbedFragment(input: EvidenceFragmentWriteInput): Promise<number[] | undefined> {
  try {
    return await embedOne(input.content, "passage");
  } catch {
    return undefined;
  }
}

export async function createEvidenceFragment(input: EvidenceFragmentWriteInput) {
  const embedding = await tryEmbedFragment(input);
  const [inserted] = await db
    .insert(evidenceFragments)
    .values({
      sourceId: input.sourceId,
      locator: input.locator,
      content: input.content,
      metadata: input.metadata ?? {},
      embedding,
    })
    .returning({ id: evidenceFragments.id });
  return inserted;
}

export async function updateEvidenceFragment(id: string, input: EvidenceFragmentWriteInput) {
  const embedding = await tryEmbedFragment(input);
  const [updated] = await db
    .update(evidenceFragments)
    .set({
      sourceId: input.sourceId,
      locator: input.locator,
      content: input.content,
      metadata: input.metadata ?? {},
      embedding,
    })
    .where(eq(evidenceFragments.id, id))
    .returning({ id: evidenceFragments.id });
  return updated ?? null;
}

export async function deleteEvidenceFragment(id: string) {
  const [deleted] = await db
    .delete(evidenceFragments)
    .where(eq(evidenceFragments.id, id))
    .returning({ id: evidenceFragments.id });
  return deleted ?? null;
}
