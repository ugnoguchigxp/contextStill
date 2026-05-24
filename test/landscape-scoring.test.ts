import { describe, expect, test } from "vitest";
import {
  LANDSCAPE_DEFAULT_THRESHOLDS,
  scoreLandscapeCommunity,
} from "../src/modules/landscape/landscape.scoring.js";

function baseInput() {
  return {
    selectedItemCountWindow: 10,
    cumulativeCompileSelectCount: 10,
    activeCount: 4,
    embeddedRatio: 1,
    zeroUseActiveCount: 0,
    usedCountWindow: 8,
    notUsedCountWindow: 2,
    offTopicCountWindow: 0,
    wrongCountWindow: 0,
    sourceRefDensity: 1,
    avgImportance: 80,
    avgConfidence: 80,
    avgFreshnessFactor: 0.9,
    avgStalenessFactor: 0.1,
    minSelectedCount: 3,
    minFeedbackCount: 3,
  };
}

describe("landscape scoring", () => {
  test("not_used は NegativeScore に加算しない", () => {
    const result = scoreLandscapeCommunity({
      ...baseInput(),
      usedCountWindow: 0,
      notUsedCountWindow: 10,
      offTopicCountWindow: 0,
      wrongCountWindow: 0,
    });

    expect(result.negativeScore).toBe(0);
    expect(result.classification.primary).toBe("over_selected_not_used");
  });

  test("freshnessFactor が高いほど AttractorScore が高くなる", () => {
    const fresh = scoreLandscapeCommunity({
      ...baseInput(),
      avgFreshnessFactor: 1,
      avgStalenessFactor: 0,
    });
    const stale = scoreLandscapeCommunity({
      ...baseInput(),
      avgFreshnessFactor: 0.2,
      avgStalenessFactor: 0.8,
    });

    expect(fresh.attractorScore).toBeGreaterThan(stale.attractorScore);
  });

  test("feedback insufficient では negative_attractor_candidate にしない", () => {
    const result = scoreLandscapeCommunity({
      ...baseInput(),
      selectedItemCountWindow: 8,
      usedCountWindow: 0,
      notUsedCountWindow: 0,
      offTopicCountWindow: 2,
      wrongCountWindow: 0,
      minFeedbackCount: 3,
    });

    expect(result.feedbackConfidence).toBe("insufficient");
    expect(result.classification.primary).toBe("feedback_insufficient");
  });

  test("feedback insufficient では useful_attractor にしない", () => {
    const result = scoreLandscapeCommunity({
      ...baseInput(),
      selectedItemCountWindow: 3,
      usedCountWindow: 1,
      notUsedCountWindow: 0,
      offTopicCountWindow: 0,
      wrongCountWindow: 0,
      minFeedbackCount: 3,
    });

    expect(result.feedbackConfidence).toBe("insufficient");
    expect(result.classification.primary).toBe("feedback_insufficient");
  });

  test("zero-use active + source evidence で dead_zone_reachability_risk になる", () => {
    const result = scoreLandscapeCommunity({
      ...baseInput(),
      selectedItemCountWindow: 0,
      cumulativeCompileSelectCount: 0,
      activeCount: 5,
      zeroUseActiveCount: 5,
      usedCountWindow: 0,
      notUsedCountWindow: 0,
      offTopicCountWindow: 0,
      wrongCountWindow: 0,
      sourceRefDensity: 1.2,
      avgImportance: 90,
      avgConfidence: 90,
      embeddedRatio: 1,
      avgFreshnessFactor: 0.9,
      avgStalenessFactor: 0.1,
    });

    expect(result.classification.primary).toBe("dead_zone_reachability_risk");
    expect(result.reachabilityRiskScore).toBeGreaterThanOrEqual(
      LANDSCAPE_DEFAULT_THRESHOLDS.deadZone.reachabilityRiskMin,
    );
  });

  test("wrong verdict がある場合は negative candidate と wrong_review_required flag を付ける", () => {
    const result = scoreLandscapeCommunity({
      ...baseInput(),
      usedCountWindow: 2,
      notUsedCountWindow: 1,
      offTopicCountWindow: 1,
      wrongCountWindow: 1,
    });

    expect(result.classification.primary).toBe("negative_attractor_candidate");
    expect(result.classification.flags).toContain("wrong_review_required");
  });
});
