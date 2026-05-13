import { eq } from "drizzle-orm";
import { closeDbPool, db } from "./index.js";
import { knowledgeItems } from "./schema.js";

async function main(): Promise<void> {
  const id = "00000000-0000-0000-0000-000000000001";
  const existing = await db.query.knowledgeItems.findFirst({
    where: eq(knowledgeItems.id, id),
  });
  if (existing) {
    console.log("seed already applied");
    return;
  }

  await db.insert(knowledgeItems).values({
    id,
    type: "rule",
    status: "active",
    scope: "repo",
    title: "Evidence First",
    body: "Separate instruction from evidence and include evidence refs in context packs.",
    appliesTo: { repos: ["memory-router"] },
    confidence: 0.95,
    importance: 0.9,
  });

  console.log("seed inserted");
}

main()
  .catch((error) => {
    console.error("[seed] failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbPool();
  });
