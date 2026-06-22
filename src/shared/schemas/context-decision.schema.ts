import { z } from "zod";

export const contextDecisionValueSchema = z.enum([
  "execute",
  "reject",
  "revise_and_execute",
  "rollback",
  "discard",
  "escalate",
]);
export const contextDecisionStatusSchema = z.enum(["completed", "degraded", "failed"]);
export const contextDecisionEvidenceRoleSchema = z.enum([
  "selected_support",
  "counter_evidence",
  "rejected_alternative",
  "user_preference",
  "risk_warning",
  "missing_counter_evidence",
]);
export const contextDecisionCoverageQueryRoleSchema = z.enum([
  "support",
  "counter_evidence",
  "user_preference",
  "risk",
  "verification",
  "alternative",
]);
export const contextDecisionHumanFeedbackValueSchema = z.enum(["good", "bad"]);
export const contextDecisionFeedbackSourceSchema = z.enum(["ai", "system"]);
export const contextDecisionFeedbackOutcomeSchema = z.enum([
  "success",
  "failed",
  "discarded_pr",
  "user_overrode",
  "regression_found",
  "still_unknown",
]);
export const contextDecisionEffectSchema = z.enum(["boost", "penalize", "neutral"]);
export const contextDecisionFeedbackEffectStatusSchema = z.enum([
  "applied",
  "queued_for_review",
  "skipped",
]);

export const contextDecisionRetrievalHintsSchema = z
  .object({
    technologies: z.array(z.string()).default([]),
    changeTypes: z.array(z.string()).default([]),
    domains: z.array(z.string()).default([]),
  })
  .default({});

export const contextDecisionInputSchema = z.object({
  decisionPoint: z.string().min(1),
  retrievalHints: contextDecisionRetrievalHintsSchema,
  sessionId: z.string().optional(),
  metadata: z.record(z.unknown()).default({}),
});

export const contextDecisionFeedbackInputSchema = z
  .object({
    decisionId: z.string().uuid(),
    source: z.enum(["human", "ai", "system"]),
    value: contextDecisionHumanFeedbackValueSchema.optional(),
    outcome: contextDecisionFeedbackOutcomeSchema.optional(),
    reason: z.string().optional(),
    metadata: z.record(z.unknown()).default({}),
  })
  .superRefine((input, ctx) => {
    if (input.source === "human" && !input.value) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["value"],
        message: "Human feedback requires value good or bad.",
      });
    }
    if (input.source !== "human" && !input.outcome) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outcome"],
        message: "AI/system feedback requires outcome.",
      });
    }
  });

export const contextDecisionListQuerySchema = z.object({
  decision: contextDecisionValueSchema.optional(),
  status: contextDecisionStatusSchema.optional(),
  feedback: z.enum(["good", "bad", "none"]).optional(),
  q: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().optional(),
});

export const contextDecisionIdParamSchema = z.object({
  id: z.string().uuid(),
});

export const contextDecisionHumanFeedbackWriteSchema = z.object({
  value: contextDecisionHumanFeedbackValueSchema,
});

export type ContextDecisionInput = z.infer<typeof contextDecisionInputSchema>;
export type ContextDecisionFeedbackInput = z.infer<typeof contextDecisionFeedbackInputSchema>;
export type ContextDecisionListQuery = z.infer<typeof contextDecisionListQuerySchema>;
export type ContextDecisionValue = z.infer<typeof contextDecisionValueSchema>;
export type ContextDecisionStatus = z.infer<typeof contextDecisionStatusSchema>;
export type ContextDecisionEvidenceRole = z.infer<typeof contextDecisionEvidenceRoleSchema>;
export type ContextDecisionCoverageQueryRole = z.infer<
  typeof contextDecisionCoverageQueryRoleSchema
>;
export type ContextDecisionHumanFeedbackValue = z.infer<
  typeof contextDecisionHumanFeedbackValueSchema
>;
export type ContextDecisionFeedbackSource = z.infer<typeof contextDecisionFeedbackSourceSchema>;
export type ContextDecisionFeedbackOutcome = z.infer<typeof contextDecisionFeedbackOutcomeSchema>;
export type ContextDecisionEffect = z.infer<typeof contextDecisionEffectSchema>;
export type ContextDecisionFeedbackEffectStatus = z.infer<
  typeof contextDecisionFeedbackEffectStatusSchema
>;
export type ContextDecisionRetrievalHints = z.infer<typeof contextDecisionRetrievalHintsSchema>;

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

export type ContextDecisionRetrievalMethod = "vector" | "keyword" | "facet" | "hybrid";

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
  signalSummary?: {
    status: "complete" | "partial" | "failed";
    compileWrongCount: number;
    compileOffTopicCount: number;
    negativeAttractorCount: number;
    strongAttractorCount: number;
    cappedCommunityCount: number;
    reason: string;
  };
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

export type ContextDecisionCandidateTrace = {
  knowledgeId: string;
  chunkId: string | null;
  role: ContextDecisionCoverageQueryRole;
  retrievalMethod: ContextDecisionRetrievalMethod;
  vectorStatus?: "available" | "unavailable";
  vectorSimilarity: number | null;
  keywordScore: number;
  facetScore: number;
  sourceQualityScore: number;
  feedbackSignalScore: number;
  finalCandidateScore: number;
  selected: boolean;
  selectionStage?:
    | "retrieved"
    | "relevance_filtered"
    | "role_fit_classified"
    | "selected"
    | "suppressed";
  topicalRelevanceScore?: number;
  topicalRelevanceReason?: string;
  roleFit?: ContextDecisionRoleFit;
  selectionReason: string | null;
  rejectionReason: string | null;
};

export type ContextDecisionPrimaryEvidence = {
  kind:
    | "git_status"
    | "verification_result"
    | "file_state"
    | "db_row"
    | "runtime_log"
    | "user_instruction"
    | "other";
  title: string;
  summary: string;
  strength: "verified" | "observed" | "claimed" | "inferred";
  sourceRef?: string;
  metadata?: Record<string, unknown>;
};

export type ContextDecisionEpisodePrecedent = {
  episodeId: string;
  title: string;
  situation: string;
  action: string;
  outcome: string;
  lesson: string;
  outcomeKind: "success" | "failure" | "mixed" | "unknown";
  importance: number;
  confidence: number;
  topicalRelevanceScore: number;
  usedFor: "risk_cap" | "background" | "support_hint";
  refs: string[];
};

export type ContextDecisionRoleFit = {
  classification:
    | "direct_support"
    | "direct_risk"
    | "counter_evidence"
    | "verification_requirement"
    | "procedural_background"
    | "off_topic";
  confidence: number;
  reason: string;
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

export type ContextDecisionConfidenceTrace = {
  supportScore: number;
  counterScore: number;
  preferenceScore: number;
  riskSignalScore: number;
  coverageScore: number;
  verificationScore: number;
  historicalFeedbackScore: number;
  finalConfidence: number;
  forcedRules: string[];
  primaryEvidence?: ContextDecisionPrimaryEvidence[];
  episodePrecedents?: ContextDecisionEpisodePrecedent[];
  directEvidenceRatio?: number;
  primaryEvidenceStrength?: ContextDecisionPrimaryEvidence["strength"] | "none";
  episodePrecedentRisk?: number;
  topicalRelevanceAverage?: number;
  roleFitPassRate?: number;
  confidenceCaps?: Array<{
    key: string;
    cap: number;
    reason: string;
  }>;
  signalStatus?: {
    status: "complete" | "partial" | "failed";
    evidenceCount: number;
    compileSignalCount: number;
    communitySignalCount: number;
    landscapeSignalCount: number;
    reason: string;
  };
  compileSignals?: Record<string, unknown>;
  communitySignals?: Record<string, unknown>;
  landscapeSignals?: Record<string, unknown>;
  knowledgeAssessment?: ContextDecisionKnowledgeAssessment;
  knowledgePrior?: ContextDecisionKnowledgePrior;
  outcomePredictor?: ContextDecisionMlSignal;
  candidateTraces?: ContextDecisionCandidateTrace[];
  mlSignal?: ContextDecisionMlSignal;
  llmJudgmentStatus?: "completed" | "fallback" | "repaired";
  reliabilityGate?: ContextDecisionReliabilityGate;
};

export type ContextDecisionEvidence = {
  id: string;
  decisionRunId: string;
  knowledgeId: string | null;
  role: ContextDecisionEvidenceRole;
  weightAtDecision: number;
  dynamicScoreAtDecision: number | null;
  applicabilityScore: number | null;
  temporalRelevance: number | null;
  summary: string;
  sourceRefs: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type ContextDecisionCoverageTrace = {
  id: string;
  decisionRunId: string;
  query: string;
  queryRole: ContextDecisionCoverageQueryRole;
  scope: Record<string, unknown>;
  hitCount: number;
  maxSimilarity: number | null;
  selectedKnowledgeIds: string[];
  rejectedKnowledgeIds: string[];
  reason: string;
  createdAt: string;
};

export type ContextDecisionHumanFeedback = {
  id: string;
  decisionRunId: string;
  value: ContextDecisionHumanFeedbackValue;
  createdAt: string;
};

export type ContextDecisionFeedback = {
  id: string;
  decisionRunId: string;
  source: ContextDecisionFeedbackSource;
  outcome: ContextDecisionFeedbackOutcome;
  inferredReason: string;
  affectedKnowledgeIds: string[];
  suggestedAdjustment: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type ContextDecisionFeedbackEffect = {
  id: string;
  feedbackId: string | null;
  humanFeedbackId: string | null;
  decisionRunId: string;
  knowledgeId: string | null;
  effect: ContextDecisionEffect;
  amount: number;
  reason: string;
  confidence: number;
  status: ContextDecisionFeedbackEffectStatus;
  appliedAt: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type ContextDecisionRunSummary = {
  id: string;
  sessionId: string | null;
  decisionPoint: string;
  decision: ContextDecisionValue;
  selectedAction: string | null;
  mandate: string;
  confidence: number;
  status: ContextDecisionStatus;
  humanFeedback: ContextDecisionHumanFeedbackValue | null;
  createdAt: string;
  updatedAt: string;
};

export type ContextDecisionRunDetail = {
  run: ContextDecisionRunSummary & {
    rejectedActions: string[];
    retrievalHints: ContextDecisionRetrievalHints;
    agentMessage: string;
    confidenceTrace: ContextDecisionConfidenceTrace;
    guardrails: Record<string, unknown>;
    unsupportedAlternatives: Array<Record<string, unknown>>;
    metadata: Record<string, unknown>;
  };
  evidence: ContextDecisionEvidence[];
  coverage: ContextDecisionCoverageTrace[];
  feedback: ContextDecisionFeedback[];
  effects: ContextDecisionFeedbackEffect[];
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
