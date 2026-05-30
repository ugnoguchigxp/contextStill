import { db, closeDbPool } from "../db/index.js";
import { knowledgeItems } from "../db/schema.js";
import { ilike, or } from "drizzle-orm";

async function main() {
  const args = process.argv.slice(2);
  const isAll = args.includes("--all");
  const queryArgIndex = args.indexOf("--query");
  const query = queryArgIndex !== -1 ? args[queryArgIndex + 1] : null;

  try {
    if (isAll) {
      console.log("⚠️  WARNING: You are about to clear ALL distilled knowledge items in the memory system.");
      console.log("Clearing knowledge_items database table...");
      
      const result = await db.delete(knowledgeItems).returning({ id: knowledgeItems.id });
      console.log(`✅ Success: Reset completed. Deleted ${result.length} knowledge items from the memory system.`);
    } else if (query) {
      console.log(`Searching for knowledge items matching keyword: "${query}"...`);
      
      const matched = await db
        .select({ id: knowledgeItems.id, title: knowledgeItems.title })
        .from(knowledgeItems)
        .where(
          or(
            ilike(knowledgeItems.title, `%${query}%`),
            ilike(knowledgeItems.body, `%${query}%`)
          )
        );

      if (matched.length === 0) {
        console.log("No matching knowledge items found in the memory system.");
        return;
      }

      console.log(`Found ${matched.length} matching items:`);
      for (const item of matched) {
        console.log(`- [${item.id}] ${item.title}`);
      }

      console.log(`\nDeleting ${matched.length} matching items...`);
      const deleted = await db
        .delete(knowledgeItems)
        .where(
          or(
            ilike(knowledgeItems.title, `%${query}%`),
            ilike(knowledgeItems.body, `%${query}%`)
          )
        )
        .returning({ id: knowledgeItems.id });

      console.log(`✅ Success: Deleted ${deleted.length} matching knowledge items from the memory system.`);
    } else {
      console.log("Antigravity / Memory-Router Knowledge Memory Reset Utility");
      console.log("Usage:");
      console.log("  bun run src/cli/reset-antigravity-memory.ts --all            Clear ALL knowledge items in the system");
      console.log("  bun run src/cli/reset-antigravity-memory.ts --query <text>   Find and delete specific knowledge items matching <text>");
    }
  } catch (error) {
    console.error("❌ Failed to reset knowledge memory:", error);
  } finally {
    await closeDbPool();
  }
}

main();
