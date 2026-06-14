export type ContextDecisionValue =
  | "execute"
  | "reject"
  | "revise_and_execute"
  | "rollback"
  | "discard"
  | "escalate";

export type ContextDecisionRequest = {
  decisionPoint: string;
  retrievalHints?: {
    technologies?: string[];
    changeTypes?: string[];
    domains?: string[];
  };
  metadata?: Record<string, unknown>;
};

export type ContextDecisionResult = {
  decisionId: string;
  decision: ContextDecisionValue;
  mandate: string;
  confidence: number;
  agentMessage: string;
  feedbackHandle: {
    decisionId: string;
    tool: "context_decision_feedback";
  };
  coverageSummary: {
    queryCount: number;
    supportHits: number;
    counterEvidenceHits: number;
    degraded: boolean;
  };
};

export type ContextDecisionRunSummary = {
  id: string;
  sessionId: string | null;
  decisionPoint: string;
  decision: ContextDecisionValue;
  selectedAction: string | null;
  mandate: string;
  confidence: number;
  status: "completed" | "degraded" | "failed";
  humanFeedback: "good" | "bad" | null;
  createdAt: string;
  updatedAt: string;
};

export type ContextDecisionMlSignal = {
  status: "ready" | "insufficient_data" | "low_confidence" | "disabled" | "failed";
  model: "ml-random-forest";
  modelVersion: string;
  featureVersion: "context-decision-ml-features-v1";
  predictedDecision?: ContextDecisionValue;
  confidence?: number;
  trainingSampleCount: number;
  classDistribution: Record<string, number>;
  features: Record<string, number>;
  reason: string;
};

export type ContextDecisionKnowledgeAssessment = {
  status: "evaluable" | "weak_coverage" | "no_evidence" | "failed";
  recommendedDirection:
    | "execute"
    | "revise_and_execute"
    | "reject"
    | "discard"
    | "rollback"
    | "escalate"
    | "unknown";
  knowledgeCoverage: number;
  supportStrength: number;
  counterEvidenceStrength: number;
  riskStrength: number;
  preferenceAlignment: number;
  applicabilityScore: number;
  consensusScore: number;
  conflictScore: number;
  sourceQualityScore: number;
  outOfDistributionScore: number;
  retrievalMethods: Array<"vector" | "keyword" | "hybrid">;
  reason: string;
  meaningfulMetrics?: Array<{
    key:
      | "knowledgeCoverage"
      | "supportStrength"
      | "counterEvidenceStrength"
      | "riskStrength"
      | "preferenceAlignment"
      | "applicabilityScore"
      | "consensusScore"
      | "conflictScore"
      | "outOfDistributionScore";
    label: string;
    value: number;
  }>;
};

export type ContextDecisionKnowledgePrior = {
  status: "available" | "limited" | "unavailable";
  source: "retrieval_prior_v1";
  referenceOnly: true;
  notUsedForScoring: true;
  evidenceCount: number;
  candidateCount: number;
  summary: string;
  signals: string[];
  cautions: string[];
};

export type ContextDecisionReliabilityGate = {
  status: "passed" | "constrained";
  originalDecision: ContextDecisionValue;
  finalDecision: ContextDecisionValue;
  confidenceCap: number | null;
  appliedRules: Array<{
    key: string;
    severity: "info" | "warning" | "blocking";
    message: string;
  }>;
  riskEvidence: {
    count: number;
    forcedDisplay: boolean;
    titles: string[];
  };
  badFeedback: {
    count: number;
    strongCount: number;
    averageConfidence: number;
    maxConfidence: number;
  };
  evidenceCoverage: {
    assessmentStatus: ContextDecisionKnowledgeAssessment["status"];
    supportEvidenceCount: number;
    riskEvidenceCount: number;
    knowledgeCoverage: number;
  };
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
    rejectedActions: string[];
    retrievalHints: {
      technologies: string[];
      changeTypes: string[];
      domains: string[];
    };
    agentMessage: string;
    confidenceTrace: Record<string, unknown>;
    guardrails: Record<string, unknown>;
    unsupportedAlternatives: Array<Record<string, unknown>>;
    metadata: Record<string, unknown>;
  };
  evidence: ContextDecisionEvidence[];
  coverage: Array<{
    id: string;
    query: string;
    queryRole:
      | "support"
      | "counter_evidence"
      | "user_preference"
      | "risk"
      | "verification"
      | "alternative";
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

export async function createContextDecision(
  input: ContextDecisionRequest,
): Promise<ContextDecisionResult> {
  const response = await fetch("/api/context-decisions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(`Create context decision failed: ${response.status}`);
  }
  return (await response.json()) as ContextDecisionResult;
}

export async function fetchContextDecisionRuns(limit = 30): Promise<ContextDecisionRunSummary[]> {
  const response = await fetch(`/api/context-decisions?limit=${limit}`);
  if (!response.ok) {
    throw new Error(`Fetch context decisions failed: ${response.status}`);
  }
  const json = (await response.json()) as {
    decisions: ContextDecisionRunSummary[];
  };
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
  const json = (await response.json()) as {
    detail: ContextDecisionRunDetail | null;
  };
  return json.detail;
}
