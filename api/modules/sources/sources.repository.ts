import { eq } from "drizzle-orm";
import { db } from "../../../src/db/index.js";
import { sources } from "../../../src/db/schema.js";

export async function deleteSourceByUri(uri: string) {
  const [deleted] = await db
    .delete(sources)
    .where(eq(sources.uri, uri))
    .returning({ id: sources.id });
  return deleted ?? null;
}
