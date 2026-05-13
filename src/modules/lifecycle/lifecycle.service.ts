import type { RetrievalMode } from "../../shared/schemas/compile.schema.js";
import type { KnowledgeStatus } from "../../shared/schemas/knowledge.schema.js";

const knowledgeLifecycleTransitions: Record<KnowledgeStatus, KnowledgeStatus[]> = {
  candidate: ["draft", "rejected"],
  draft: ["trial", "rejected", "deprecated"],
  trial: ["active", "deprecated", "rejected"],
  active: ["deprecated"],
  deprecated: ["active", "rejected"],
  rejected: ["candidate"],
};

export function canTransitionKnowledgeStatus(from: KnowledgeStatus, to: KnowledgeStatus): boolean {
  return knowledgeLifecycleTransitions[from]?.includes(to) ?? false;
}

export function resolveKnowledgeSearchStatuses(params: {
  retrievalMode: RetrievalMode;
  includeTrial: boolean;
}): KnowledgeStatus[] {
  if (params.retrievalMode === "learning_context") {
    return ["active", "trial", "draft", "candidate"];
  }
  if (params.includeTrial) {
    return ["active", "trial"];
  }
  return ["active"];
}
