export const requiredTables = [
  "knowledge_items",
  "sources",
  "source_fragments",
  "knowledge_source_links",
  "vibe_memories",
  "agent_diff_entries",
  "vibe_memory_distillation_runs",
  "source_distillation_runs",
  "source_distillation_evidence",
  "context_compile_runs",
  "context_pack_items",
  "sync_states",
] as const;

export const requiredTableSqlList = requiredTables.map((tableName) => `'${tableName}'`).join(", ");

export const requiredPrimaryMcpTools = [
  "initial_instructions",
  "context_compile",
  "search_knowledge",
  "register_knowledge",
  "memory_search",
  "memory_fetch",
  "doctor",
] as const;
