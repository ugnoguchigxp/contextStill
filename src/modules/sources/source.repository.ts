import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { sources } from "../../db/schema.js";

type UpsertSourceParams = {
  sourceKind: "markdown" | "session" | "tool_output" | "git" | "web" | "manual";
  uri: string;
  title?: string;
  body: string;
  contentHash?: string;
  metadata?: Record<string, unknown>;
};

function defaultHash(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export async function upsertSourceDocument(params: UpsertSourceParams): Promise<string> {
  const contentHash =
    params.contentHash ?? defaultHash(`${params.sourceKind}\n${params.uri}\n${params.body}`);
  const existing = await db.query.sources.findFirst({
    where: and(eq(sources.uri, params.uri), eq(sources.contentHash, contentHash)),
    columns: { id: true },
  });

  if (existing) {
    await db
      .update(sources)
      .set({
        sourceKind: params.sourceKind,
        uri: params.uri,
        title: params.title ?? null,
        body: params.body,
        metadata: params.metadata ?? {},
        updatedAt: new Date(),
      })
      .where(eq(sources.id, existing.id));
    return existing.id;
  }

  const [inserted] = await db
    .insert(sources)
    .values({
      sourceKind: params.sourceKind,
      uri: params.uri,
      title: params.title ?? null,
      body: params.body,
      contentHash,
      metadata: params.metadata ?? {},
    })
    .returning({ id: sources.id });
  return inserted.id;
}
