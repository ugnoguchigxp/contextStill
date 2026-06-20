import { describe, expect, test } from "vitest";
import { applyContextDecisionReliabilityGate } from "../src/modules/context-decision/context-decision.reliability-gate.js";
import { scoreContextDecision } from "../src/modules/context-decision/context-decision.scoring.js";
import type { DecisionEvidenceCandidate } from "../src/modules/context-decision/context-decision.scoring.js";
import type {
  ContextDecisionKnowledgeAssessment,
  ContextDecisionValue,
} from "../src/shared/schemas/context-decision.schema.js";
import type { KnowledgeSearchResult } from "../src/modules/knowledge/knowledge.repository.js";

const input = {
  decisionPoint: "calibrate decision signal behavior",
  retrievalHints: { technologies: ["typescript"], changeTypes: ["implementation"], domains: [] },
  metadata: {},
};

function knowledge(overrides: Partial<KnowledgeSearchResult> = {}): KnowledgeSearchResult {
  return {
    id: overrides.id ?? "00000000-0000-0000-0000-000000000001",
    type: "rule",
    status: "active",
    scope: "repo",
    polarity: overrides.polarity ?? "positive",
    intentTags: overrides.intentTags ?? [],
    title: overrides.title ?? "Calibration rule",
    body: overrides.body ?? "Use this evidence for calibration.",
    confidence: overrides.confidence ?? 86,
    importance: overrides.importance ?? 84,
    score: overrides.score ?? 0.9,
    appliesTo: {},
    metadata: {},
    sourceRefs: ["file:///calibration.md#line:1"],
    hasSourceLinks: true,
    dynamicScore: overrides.dynamicScore ?? 20,
    compileSelectCount: overrides.compileSelectCount ?? 1,
    agenticAcceptCount: 0,
    explicitUpvoteCount: 0,
    explicitDownvoteCount: 0,
    lastCompiledAt: null,
    lastVerifiedAt: null,
    updatedAt: new Date(),
    decayFactor: 1,
    applicabilityScore: overrides.applicabilityScore ?? 30,
    applicabilityMatches: { technologies: [], changeTypes: [], domains: [], general: true },
    ...overrides,
  };
}

function assessment(
  overrides: Partial<ContextDecisionKnowledgeAssessment> = {},
): ContextDecisionKnowledgeAssessment {
  return {
    status: "evaluable",
    recommendedDirection: "execute",
    knowledgeCoverage: 85,
    supportStrength: 84,
    counterEvidenceStrength: 0,
    riskStrength: 0,
    preferenceAlignment: 0,
    applicabilityScore: 80,
    consensusScore: 82,
    conflictScore: 0,
    sourceQualityScore: 90,
    outOfDistributionScore: 0,
    retrievalMethods: ["keyword"],
    reason: "Calibration assessment.",
    ...overrides,
  };
}

function judgment(decision: ContextDecisionValue = "execute") {
  return {
    decision,
    confidence: 88,
    mandate: "Proceed.",
    selectedAction: "run",
    rejectedActions: [],
    reasoningSummary: "Calibration judgment.",
  };
}

const noBadFeedback = {
  count: 0,
  strongCount: 0,
  averageConfidence: 0,
  maxConfidence: 0,
};

function finalDecision(params: {
  evidence: DecisionEvidenceCandidate[];
  assessment?: Partial<ContextDecisionKnowledgeAssessment>;
  judgment?: ContextDecisionValue;
}) {
  return applyContextDecisionReliabilityGate({
    judgment: judgment(params.judgment ?? "execute"),
    knowledgeAssessment: assessment(params.assessment),
    evidence: params.evidence,
    relatedBadSignalSummary: noBadFeedback,
  });
}

describe("context decision calibration fixtures", () => {
  test("minimal safe execute remains executable", () => {
    const evidence: DecisionEvidenceCandidate[] = [
      {
        knowledge: knowledge({ id: "00000000-0000-0000-0000-000000000101" }),
        role: "selected_support",
      },
    ];
    const scored = scoreContextDecision({
      input,
      evidence,
      coverage: [
        { queryRole: "support", hitCount: 1 },
        { queryRole: "counter_evidence", hitCount: 0 },
      ],
      relatedBadSignalCount: 0,
    });
    const gated = finalDecision({ evidence });

    expect(scored.status).toBe("completed");
    expect(gated.judgment.decision).toBe("execute");
    expect(gated.gate.status).toBe("passed");
  });

  test("counter evidence revises direct execution", () => {
    const evidence: DecisionEvidenceCandidate[] = [
      {
        knowledge: knowledge({ id: "00000000-0000-0000-0000-000000000102" }),
        role: "selected_support",
      },
      {
        knowledge: knowledge({
          id: "00000000-0000-0000-0000-000000000103",
          title: "Counter evidence",
        }),
        role: "counter_evidence",
      },
    ];
    const gated = finalDecision({
      evidence,
      assessment: {
        status: "weak_coverage",
        recommendedDirection: "revise_and_execute",
        conflictScore: 58,
        counterEvidenceStrength: 82,
      },
    });

    expect(gated.judgment.decision).toBe("revise_and_execute");
    expect(gated.gate.appliedRules.map((item) => item.key)).toContain(
      "weak_coverage_requires_revision",
    );
  });

  test("negative attractor reject blocks execute", () => {
    const gated = finalDecision({
      evidence: [
        {
          knowledge: knowledge({ id: "00000000-0000-0000-0000-000000000104" }),
          role: "selected_support",
          signals: {
            landscape: {
              classification: "negative_attractor_candidate",
              confidence: "high",
              attractorScore: 20,
              negativeScore: 88,
              reachabilityRiskScore: 10,
              usedRate: 0.1,
              notUsedRate: 0.3,
              offTopicRate: 0.3,
              wrongRate: 0.3,
              flags: [],
            },
          },
        },
      ],
    });

    expect(gated.judgment.decision).toBe("reject");
    expect(gated.gate.appliedRules.map((item) => item.key)).toContain(
      "negative_attractor_blocks_execute",
    );
  });

  test("strong attractor can support execute", () => {
    const gated = finalDecision({
      evidence: [
        {
          knowledge: knowledge({ id: "00000000-0000-0000-0000-000000000105" }),
          role: "selected_support",
          signals: {
            landscape: {
              classification: "strong_attractor",
              confidence: "high",
              attractorScore: 92,
              negativeScore: 0,
              reachabilityRiskScore: 0,
              usedRate: 0.9,
              notUsedRate: 0.05,
              offTopicRate: 0,
              wrongRate: 0,
              flags: [],
            },
          },
        },
      ],
    });

    expect(gated.judgment.decision).toBe("execute");
    expect(gated.gate.appliedRules.map((item) => item.key)).toContain(
      "strong_attractor_supports_execute",
    );
  });

  test("over selected not used requires revision", () => {
    const gated = finalDecision({
      evidence: [
        {
          knowledge: knowledge({ id: "00000000-0000-0000-0000-000000000106" }),
          role: "selected_support",
          signals: {
            landscape: {
              classification: "over_selected_not_used",
              confidence: "medium",
              attractorScore: 50,
              negativeScore: 10,
              reachabilityRiskScore: 20,
              usedRate: 0.1,
              notUsedRate: 0.8,
              offTopicRate: 0,
              wrongRate: 0,
              flags: [],
            },
          },
        },
      ],
    });

    expect(gated.judgment.decision).toBe("revise_and_execute");
    expect(gated.gate.appliedRules.map((item) => item.key)).toContain(
      "over_selected_not_used_requires_revision",
    );
  });

  test("stale and thin community caps confidence", () => {
    const gated = finalDecision({
      evidence: [
        {
          knowledge: knowledge({ id: "00000000-0000-0000-0000-000000000107" }),
          role: "selected_support",
          signals: {
            community: {
              communityKey: "thin-stale",
              communityLabel: "Thin stale",
              communityRank: 2,
              sourceRefDensity: 0.05,
              compileSelectCount: 2,
              health: { dead: false, stale: true, thinEvidence: true },
            },
          },
        },
      ],
    });

    expect(gated.judgment.confidence).toBe(68);
    expect(gated.gate.appliedRules.map((item) => item.key)).toEqual(
      expect.arrayContaining(["thin_community_caps_confidence", "stale_community_caps_confidence"]),
    );
  });
});
