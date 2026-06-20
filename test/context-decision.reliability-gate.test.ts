import { describe, expect, test } from "vitest";
import { applyContextDecisionReliabilityGate } from "../src/modules/context-decision/context-decision.reliability-gate.js";
import type { DecisionEvidenceCandidate } from "../src/modules/context-decision/context-decision.scoring.js";
import type {
  ContextDecisionKnowledgeAssessment,
  ContextDecisionValue,
} from "../src/shared/schemas/context-decision.schema.js";
import type { KnowledgeSearchResult } from "../src/modules/knowledge/knowledge.repository.js";

function knowledge(overrides: Partial<KnowledgeSearchResult> = {}): KnowledgeSearchResult {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    type: "rule",
    status: "active",
    scope: "repo",
    polarity: "positive",
    intentTags: [],
    title: "Use evidence",
    body: "Evidence backed rule.",
    confidence: 80,
    importance: 80,
    score: 1,
    appliesTo: {},
    metadata: {},
    sourceRefs: ["file:///rule.md#line:1"],
    hasSourceLinks: true,
    dynamicScore: 20,
    compileSelectCount: 1,
    agenticAcceptCount: 0,
    explicitUpvoteCount: 0,
    explicitDownvoteCount: 0,
    lastCompiledAt: null,
    lastVerifiedAt: null,
    updatedAt: new Date(),
    decayFactor: 1,
    applicabilityScore: 10,
    applicabilityMatches: { technologies: [], changeTypes: [], domains: [], general: false },
    ...overrides,
  };
}

function assessment(
  overrides: Partial<ContextDecisionKnowledgeAssessment> = {},
): ContextDecisionKnowledgeAssessment {
  return {
    status: "evaluable",
    recommendedDirection: "execute",
    knowledgeCoverage: 80,
    supportStrength: 80,
    counterEvidenceStrength: 0,
    riskStrength: 0,
    preferenceAlignment: 0,
    applicabilityScore: 80,
    consensusScore: 80,
    conflictScore: 0,
    sourceQualityScore: 80,
    outOfDistributionScore: 0,
    retrievalMethods: ["keyword"],
    reason: "Enough evidence.",
    ...overrides,
  };
}

function judgment(decision: ContextDecisionValue = "execute") {
  return {
    decision,
    confidence: 90,
    mandate: "Proceed.",
    selectedAction: "run",
    rejectedActions: [],
    reasoningSummary: "LLM selected the action.",
  };
}

const noBadFeedback = {
  count: 0,
  strongCount: 0,
  averageConfidence: 0,
  maxConfidence: 0,
};

describe("context decision reliability gate", () => {
  test("escalates execution when usable evidence is missing", () => {
    const result = applyContextDecisionReliabilityGate({
      judgment: judgment("execute"),
      knowledgeAssessment: assessment({
        status: "no_evidence",
        recommendedDirection: "escalate",
        knowledgeCoverage: 0,
      }),
      evidence: [],
      relatedBadSignalSummary: noBadFeedback,
    });

    expect(result.judgment.decision).toBe("escalate");
    expect(result.judgment.confidence).toBe(34);
    expect(result.gate.appliedRules.map((item) => item.key)).toContain(
      "no_usable_evidence_escalate",
    );
  });

  test("blocks execution when selected risk evidence is strong", () => {
    const riskEvidence: DecisionEvidenceCandidate[] = [
      {
        knowledge: knowledge({
          id: "00000000-0000-0000-0000-000000000002",
          title: "Do not proceed without verification",
          polarity: "negative",
        }),
        role: "risk_warning",
      },
    ];
    const result = applyContextDecisionReliabilityGate({
      judgment: judgment("execute"),
      knowledgeAssessment: assessment({ riskStrength: 85, recommendedDirection: "reject" }),
      evidence: riskEvidence,
      relatedBadSignalSummary: noBadFeedback,
    });

    expect(result.judgment.decision).toBe("reject");
    expect(result.gate.riskEvidence.forcedDisplay).toBe(true);
    expect(result.gate.riskEvidence.titles).toContain("Do not proceed without verification");
  });

  test("strong prior bad feedback suppresses direct execute", () => {
    const supportEvidence: DecisionEvidenceCandidate[] = [
      { knowledge: knowledge({ title: "Previously bad support" }), role: "selected_support" },
    ];
    const result = applyContextDecisionReliabilityGate({
      judgment: judgment("execute"),
      knowledgeAssessment: assessment(),
      evidence: supportEvidence,
      relatedBadSignalSummary: {
        count: 1,
        strongCount: 1,
        averageConfidence: 80,
        maxConfidence: 80,
      },
    });

    expect(result.judgment.decision).toBe("revise_and_execute");
    expect(result.judgment.confidence).toBe(64);
    expect(result.gate.appliedRules.map((item) => item.key)).toContain(
      "bad_feedback_suppresses_execute",
    );
  });

  test("weak prior bad feedback is recorded but does not suppress", () => {
    const supportEvidence: DecisionEvidenceCandidate[] = [
      { knowledge: knowledge({ title: "Weakly disputed support" }), role: "selected_support" },
    ];
    const result = applyContextDecisionReliabilityGate({
      judgment: judgment("execute"),
      knowledgeAssessment: assessment(),
      evidence: supportEvidence,
      relatedBadSignalSummary: {
        count: 1,
        strongCount: 0,
        averageConfidence: 55,
        maxConfidence: 55,
      },
    });

    expect(result.judgment.decision).toBe("execute");
    expect(result.gate.status).toBe("passed");
    expect(result.gate.badFeedback.count).toBe(1);
  });

  test("compile wrong signal blocks execute even when LLM selects execute", () => {
    const result = applyContextDecisionReliabilityGate({
      judgment: judgment("execute"),
      knowledgeAssessment: assessment(),
      evidence: [
        {
          knowledge: knowledge({ title: "Wrong compile support" }),
          role: "selected_support",
          signals: {
            compile: {
              compileSelectCount: 3,
              recentSelectedCount: 3,
              usedCount: 0,
              notUsedCount: 0,
              offTopicCount: 0,
              wrongCount: 1,
              suppressedCount: 0,
              rejectedByAgenticCount: 0,
              misleadingEvalCount: 0,
            },
          },
        },
      ],
      relatedBadSignalSummary: noBadFeedback,
    });

    expect(result.judgment.decision).toBe("reject");
    expect(result.gate.appliedRules.map((item) => item.key)).toContain(
      "compile_wrong_blocks_execute",
    );
  });

  test("negative attractor blocks execute and thin community caps confidence", () => {
    const result = applyContextDecisionReliabilityGate({
      judgment: judgment("execute"),
      knowledgeAssessment: assessment(),
      evidence: [
        {
          knowledge: knowledge({ title: "Negative attractor support" }),
          role: "selected_support",
          signals: {
            community: {
              communityKey: "community-a",
              communityLabel: "Community A",
              communityRank: 1,
              sourceRefDensity: 0.1,
              compileSelectCount: 5,
              health: { dead: false, stale: false, thinEvidence: true },
            },
            landscape: {
              classification: "negative_attractor_candidate",
              confidence: "high",
              attractorScore: 30,
              negativeScore: 92,
              reachabilityRiskScore: 10,
              usedRate: 0.1,
              notUsedRate: 0.2,
              offTopicRate: 0.4,
              wrongRate: 0.3,
              flags: ["wrong_review_required"],
            },
          },
        },
      ],
      relatedBadSignalSummary: noBadFeedback,
    });

    const ruleKeys = result.gate.appliedRules.map((item) => item.key);
    expect(result.judgment.decision).toBe("reject");
    expect(ruleKeys).toContain("negative_attractor_blocks_execute");
    expect(ruleKeys).toContain("thin_community_caps_confidence");
  });
});
