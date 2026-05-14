import { createHash } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { db } from "../../../src/db/index.js";
import { sourceFragments, sources } from "../../../src/db/schema.js";
import { embedOne } from "../../../src/modules/embedding/embedding.service.js";

export type SourceWriteInput = {
  sourceKind: string;
  uri: string;
  title?: string | null;
  body: string;
  contentHash?: string;
  metadata?: Record<string, unknown>;
};

export type SourceFragmentWriteInput = {
  sourceId: string;
  locator: string;
  heading?: string | null;
  content: string;
  metadata?: Record<string, unknown>;
};

function defaultHash(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export async function listSources(limit: number) {
  return db
    .select({
      id: sources.id,
      sourceKind: sources.sourceKind,
      uri: sources.uri,
      title: sources.title,
      body: sources.body,
      contentHash: sources.contentHash,
      metadata: sources.metadata,
      createdAt: sources.createdAt,
      updatedAt: sources.updatedAt,
      lastIndexedAt: sources.lastIndexedAt,
    })
    .from(sources)
    .orderBy(desc(sources.updatedAt))
    .limit(limit);
}

export async function listSourceFragments(limit: number) {
  return db
    .select({
      id: sourceFragments.id,
      sourceId: sourceFragments.sourceId,
      sourceUri: sources.uri,
      locator: sourceFragments.locator,
      heading: sourceFragments.heading,
      content: sourceFragments.content,
      metadata: sourceFragments.metadata,
      createdAt: sourceFragments.createdAt,
    })
    .from(sourceFragments)
    .innerJoin(sources, eq(sources.id, sourceFragments.sourceId))
    .orderBy(desc(sourceFragments.createdAt))
    .limit(limit);
}

export async function createSource(input: SourceWriteInput) {
  const [inserted] = await db
    .insert(sources)
    .values({
      sourceKind: input.sourceKind,
      uri: input.uri,
      title: input.title ?? null,
      body: input.body,
      contentHash:
        input.contentHash || defaultHash(`${input.sourceKind}\n${input.uri}\n${input.body}`),
      metadata: input.metadata ?? {},
    })
    .returning({ id: sources.id });
  return inserted;
}

export async function updateSource(id: string, input: SourceWriteInput) {
  const [updated] = await db
    .update(sources)
    .set({
      sourceKind: input.sourceKind,
      uri: input.uri,
      title: input.title ?? null,
      body: input.body,
      contentHash:
        input.contentHash || defaultHash(`${input.sourceKind}\n${input.uri}\n${input.body}`),
      metadata: input.metadata ?? {},
      updatedAt: new Date(),
    })
    .where(eq(sources.id, id))
    .returning({ id: sources.id });
  return updated ?? null;
}

export async function deleteSource(id: string) {
  const [deleted] = await db
    .delete(sources)
    .where(eq(sources.id, id))
    .returning({ id: sources.id });
  return deleted ?? null;
}

export async function deleteSourceByUri(uri: string) {
  const [deleted] = await db
    .delete(sources)
    .where(eq(sources.uri, uri))
    .returning({ id: sources.id });
  return deleted ?? null;
}

async function tryEmbedFragment(input: SourceFragmentWriteInput): Promise<number[] | undefined> {
  try {
    return await embedOne(input.content, "passage");
  } catch {
    return undefined;
  }
}

export async function createSourceFragment(input: SourceFragmentWriteInput) {
  const embedding = await tryEmbedFragment(input);
  const [inserted] = await db
    .insert(sourceFragments)
    .values({
      sourceId: input.sourceId,
      locator: input.locator,
      heading: input.heading ?? null,
      content: input.content,
      metadata: input.metadata ?? {},
      embedding,
    })
    .returning({ id: sourceFragments.id });
  return inserted;
}

export async function updateSourceFragment(id: string, input: SourceFragmentWriteInput) {
  const embedding = await tryEmbedFragment(input);
  const [updated] = await db
    .update(sourceFragments)
    .set({
      sourceId: input.sourceId,
      locator: input.locator,
      heading: input.heading ?? null,
      content: input.content,
      metadata: input.metadata ?? {},
      embedding,
    })
    .where(eq(sourceFragments.id, id))
    .returning({ id: sourceFragments.id });
  return updated ?? null;
}

export async function deleteSourceFragment(id: string) {
  const [deleted] = await db
    .delete(sourceFragments)
    .where(eq(sourceFragments.id, id))
    .returning({ id: sourceFragments.id });
  return deleted ?? null;
}
