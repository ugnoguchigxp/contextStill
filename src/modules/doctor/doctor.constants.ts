export const requiredTables = [
  "audit_logs",
  "knowledge_items",
  "sources",
  "source_fragments",
  "knowledge_source_links",
  "vibe_memories",
  "agent_diff_entries",
  "distillation_target_states",
  "distillation_evidence_cache",
  "find_candidate_results",
  "cover_evidence_results",
  "context_compile_runs",
  "context_pack_items",
  "sync_states",
  "settings",
] as const;

export const requiredTableSqlList = requiredTables.map((tableName) => `'${tableName}'`).join(", ");

export function getRequiredPrimaryMcpTools(): readonly string[] {
  const raw = process.env.MEMORY_ROUTER_MCP_V2?.trim().toLowerCase();
  const isV2 = !raw || !(raw === "0" || raw === "false" || raw === "no" || raw === "off");
  if (!isV2) {
    return [
      "initial_instructions",
      "context_compile",
      "search_knowledge",
      "register_candidate",
      "memory_search",
      "memory_fetch",
      "doctor",
    ] as const;
  }
  return [
    "initial_instructions",
    "context_compile",
    "search_knowledge",
    "register_candidate",
    "search_memory",
    "fetch_memory",
    "doctor",
  ] as const;
}
