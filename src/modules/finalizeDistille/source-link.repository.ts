import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { knowledgeSourceLinks } from "../../db/schema.js";

export async function linkKnowledgeToSourceFragment(params: {
  knowledgeId: string;
  sourceFragmentId: string;
  confidence: number;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const existing = await db.query.knowledgeSourceLinks.findFirst({
    where: and(
      eq(knowledgeSourceLinks.knowledgeId, params.knowledgeId),
      eq(knowledgeSourceLinks.sourceFragmentId, params.sourceFragmentId),
    ),
  });
  if (existing) return;
  await db.insert(knowledgeSourceLinks).values({
    knowledgeId: params.knowledgeId,
    sourceFragmentId: params.sourceFragmentId,
    linkType: "derived_from",
    confidence: params.confidence,
    metadata: params.metadata ?? {},
  });
}
