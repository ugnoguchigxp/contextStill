import { readProjectEnv } from "../../project-identity.js";

export const requiredTables = [
  "audit_logs",
  "knowledge_items",
  "sources",
  "source_fragments",
  "knowledge_source_links",
  "vibe_memories",
  "agent_diff_entries",
  "session_memos",
  "session_memo_events",
  "distillation_target_states",
  "distillation_evidence_cache",
  "find_candidate_results",
  "cover_evidence_results",
  "landscape_review_item_candidate_links",
  "context_compile_runs",
  "context_compile_evals",
  "context_pack_items",
  "context_decision_runs",
  "context_decision_evidence",
  "context_decision_coverage_traces",
  "context_decision_human_feedback",
  "context_decision_feedback",
  "context_decision_feedback_effects",
  "sync_states",
  "settings",
] as const;

export const requiredTableSqlList = requiredTables.map((tableName) => `'${tableName}'`).join(", ");

export function getRequiredPrimaryMcpTools(): readonly string[] {
  const raw = readProjectEnv("MCP_V2")?.trim().toLowerCase();
  const isV2 = !raw || !(raw === "0" || raw === "false" || raw === "no" || raw === "off");
  if (!isV2) {
    return [
      "initial_instructions",
      "context_compile",
      "compile_eval",
      "context_decision",
      "context_decision_feedback",
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
    "compile_eval",
    "context_decision",
    "context_decision_feedback",
    "search_knowledge",
    "register_candidate",
    "search_memory",
    "fetch_memory",
    "doctor",
  ] as const;
}
