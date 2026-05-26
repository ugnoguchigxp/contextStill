import type { RetrievalMode } from "../../shared/schemas/compile.schema.js";
import type { KnowledgeStatus } from "../../shared/schemas/knowledge.schema.js";

const knowledgeLifecycleTransitions: Record<KnowledgeStatus, KnowledgeStatus[]> = {
  draft: ["active", "deprecated"],
  active: ["deprecated"],
  deprecated: ["active"],
};

export function canTransitionKnowledgeStatus(from: KnowledgeStatus, to: KnowledgeStatus): boolean {
  return knowledgeLifecycleTransitions[from]?.includes(to) ?? false;
}

export function resolveKnowledgeSearchStatuses(params: {
  retrievalMode: RetrievalMode;
  includeDraft: boolean;
}): KnowledgeStatus[] {
  if (params.retrievalMode === "learning_context") {
    return ["active", "draft"];
  }
  if (params.includeDraft) {
    return ["active", "draft"];
  }
  return ["active"];
}
