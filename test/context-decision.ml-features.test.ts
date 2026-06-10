import { describe, expect, test } from "vitest";
import {
  buildContextDecisionMlFeatures,
  contextDecisionMlFeatureNames,
  contextDecisionMlFeatureVector,
  readContextDecisionMlFeaturesFromTrace,
} from "../src/modules/context-decision/context-decision.ml-features.js";
import type { DecisionEvidenceCandidate } from "../src/modules/context-decision/context-decision.scoring.js";
import type { KnowledgeSearchResult } from "../src/modules/knowledge/knowledge.repository.js";
import type { ContextDecisionConfidenceTrace } from "../src/shared/schemas/context-decision.schema.js";

function knowledge(id: string): KnowledgeSearchResult {
  return {
    id,
    type: "rule",
    status: "active",
    scope: "repo",
    title: "Evidence rule",
    body: "Evidence backed rule.",
    confidence: 80,
    importance: 80,
    score: 1,
    appliesTo: {},
    metadata: {},
    sourceRefs: [],
    hasSourceLinks: false,
    dynamicScore: 0,
    compileSelectCount: 0,
    agenticAcceptCount: 0,
    explicitUpvoteCount: 0,
    explicitDownvoteCount: 0,
    lastCompiledAt: null,
    lastVerifiedAt: null,
    updatedAt: new Date(),
    decayFactor: 1,
    applicabilityScore: 0,
    applicabilityMatches: { technologies: [], changeTypes: [], domains: [], general: false },
  };
}

const trace: ContextDecisionConfidenceTrace = {
  supportScore: 71,
  counterScore: 11,
  preferenceScore: Number.NaN,
  riskSignalScore: 12,
  coverageScore: 80,
  verificationScore: 50,
  historicalFeedbackScore: 38,
  finalConfidence: 64,
  forcedRules: [],
};

describe("context decision ML features", () => {
  test("builds stable finite ordered features", () => {
    const evidence: DecisionEvidenceCandidate[] = [
      { knowledge: knowledge("00000000-0000-0000-0000-000000000001"), role: "selected_support" },
      { knowledge: knowledge("00000000-0000-0000-0000-000000000002"), role: "user_preference" },
      { knowledge: knowledge("00000000-0000-0000-0000-000000000003"), role: "risk_warning" },
    ];

    const features = buildContextDecisionMlFeatures({
      input: {
        decisionPoint: "continue before asking user",
        retrievalHints: {
          technologies: ["typescript"],
          changeTypes: ["implementation", "tests"],
          domains: ["decision"],
        },
        sessionId: "s-1",
        metadata: {
          branch: "codex/context-decision",
          prUrl: "https://github.com/example/repo/pull/1",
          headSha: "abc123",
        },
      },
      evidence,
      coverage: [
        { queryRole: "support", hitCount: 2 },
        { queryRole: "user_preference", hitCount: 1 },
        { queryRole: "risk", hitCount: 1 },
        { queryRole: "counter_evidence", hitCount: 0 },
      ],
      trace,
      relatedBadSignalCount: 2,
    });

    expect(Object.keys(features)).toEqual([...contextDecisionMlFeatureNames]);
    expect(contextDecisionMlFeatureVector(features)).toHaveLength(
      contextDecisionMlFeatureNames.length,
    );
    expect(Object.values(features).every(Number.isFinite)).toBe(true);
    expect(features.preferenceScore).toBe(0);
    expect(features.hasSessionId).toBe(1);
    expect(features.metadataHasPr).toBe(1);
  });

  test("reads persisted feature sets only when every feature is present", () => {
    const features = buildContextDecisionMlFeatures({
      input: {
        decisionPoint: "continue",
        retrievalHints: { technologies: [], changeTypes: [], domains: [] },
        metadata: {},
      },
      evidence: [],
      coverage: [],
      trace,
      relatedBadSignalCount: 0,
    });

    expect(readContextDecisionMlFeaturesFromTrace({ mlSignal: { features } })).toEqual(features);
    expect(
      readContextDecisionMlFeaturesFromTrace({ mlSignal: { features: { supportHitCount: 1 } } }),
    ).toBeNull();
  });
});
