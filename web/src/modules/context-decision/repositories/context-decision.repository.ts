export type ContextDecisionValue =
  | "execute"
  | "reject"
  | "revise_and_execute"
  | "rollback"
  | "discard"
  | "escalate";

export type ContextDecisionRunSummary = {
  id: string;
  sessionId: string | null;
  taskGoal: string;
  decisionPoint: string;
  proposedAction: string | null;
  decision: ContextDecisionValue;
  selectedAction: string | null;
  mandate: string;
  confidence: number;
  status: "completed" | "degraded" | "failed";
  humanFeedback: "good" | "bad" | null;
  createdAt: string;
  updatedAt: string;
};

export type ContextDecisionEvidence = {
  id: string;
  decisionRunId: string;
  knowledgeId: string | null;
  role:
    | "selected_support"
    | "rejected_alternative"
    | "user_preference"
    | "risk_warning"
    | "missing_counter_evidence";
  weightAtDecision: number;
  summary: string;
  sourceRefs: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type ContextDecisionRunDetail = {
  run: ContextDecisionRunSummary & {
    options: string[];
    rejectedActions: string[];
    agentMessage: string;
    confidenceTrace: Record<string, unknown>;
    autonomyLevel: "low" | "medium" | "high";
    riskBudget: "low" | "medium" | "high";
    knowledgePolicy: "optional" | "required";
    availableRollback: string | null;
    verificationPlan: string | null;
    guardrails: Record<string, unknown>;
    unsupportedAlternatives: Array<Record<string, unknown>>;
    metadata: Record<string, unknown>;
  };
  evidence: ContextDecisionEvidence[];
  coverage: Array<{
    id: string;
    query: string;
    queryRole: "support" | "counter_evidence" | "user_preference" | "risk";
    hitCount: number;
    maxSimilarity: number | null;
    selectedKnowledgeIds: string[];
    rejectedKnowledgeIds: string[];
    reason: string;
    createdAt: string;
  }>;
  feedback: Array<{
    id: string;
    source: "ai" | "system";
    outcome:
      | "success"
      | "failed"
      | "discarded_pr"
      | "user_overrode"
      | "regression_found"
      | "still_unknown";
    inferredReason: string;
    createdAt: string;
  }>;
  effects: Array<{
    id: string;
    knowledgeId: string | null;
    effect: "boost" | "penalize" | "neutral";
    amount: number;
    reason: string;
    confidence: number;
    status: "applied" | "queued_for_review" | "skipped";
    createdAt: string;
  }>;
};

export async function fetchContextDecisionRuns(limit = 30): Promise<ContextDecisionRunSummary[]> {
  const response = await fetch(`/api/context-decisions?limit=${limit}`);
  if (!response.ok) {
    throw new Error(`Fetch context decisions failed: ${response.status}`);
  }
  const json = (await response.json()) as { decisions: ContextDecisionRunSummary[] };
  return json.decisions;
}

export async function fetchContextDecisionDetail(
  decisionId: string,
): Promise<ContextDecisionRunDetail> {
  const response = await fetch(`/api/context-decisions/${encodeURIComponent(decisionId)}`);
  if (!response.ok) {
    throw new Error(`Fetch context decision detail failed: ${response.status}`);
  }
  const json = (await response.json()) as { detail: ContextDecisionRunDetail };
  return json.detail;
}

export async function submitContextDecisionHumanFeedback(
  decisionId: string,
  value: "good" | "bad",
): Promise<ContextDecisionRunDetail | null> {
  const response = await fetch(
    `/api/context-decisions/${encodeURIComponent(decisionId)}/human-feedback`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value }),
    },
  );
  if (!response.ok) {
    throw new Error(`Save context decision feedback failed: ${response.status}`);
  }
  const json = (await response.json()) as { detail: ContextDecisionRunDetail | null };
  return json.detail;
}
