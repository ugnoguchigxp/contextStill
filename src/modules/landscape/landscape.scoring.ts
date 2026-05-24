import type {
  LandscapeClassificationConfidence,
  LandscapeClassificationPrimary,
  LandscapeFeedbackConfidence,
  LandscapeThresholds,
} from "./landscape.types.js";

type ScoreInput = {
  selectedItemCountWindow: number;
  cumulativeCompileSelectCount: number;
  activeCount: number;
  embeddedRatio: number;
  zeroUseActiveCount: number;
  usedCountWindow: number;
  notUsedCountWindow: number;
  offTopicCountWindow: number;
  wrongCountWindow: number;
  sourceRefDensity: number;
  avgImportance: number;
  avgConfidence: number;
  avgFreshnessFactor: number;
  avgStalenessFactor: number;
  minSelectedCount: number;
  minFeedbackCount: number;
};

type ScoreResult = {
  feedbackCountWindow: number;
  feedbackConfidence: LandscapeFeedbackConfidence;
  usedRate: number;
  notUsedRate: number;
  offTopicRate: number;
  wrongRate: number;
  attractorScore: number;
  negativeScore: number;
  reachabilityRiskScore: number;
  classification: {
    primary: LandscapeClassificationPrimary;
    flags: string[];
    confidence: LandscapeClassificationConfidence;
    reason: string;
  };
  recommendedActions: string[];
};

const FEEDBACK_CONFIDENCE_ORDER: Record<LandscapeFeedbackConfidence, number> = {
  insufficient: 0,
  low: 1,
  medium: 2,
  high: 3,
};

export const LANDSCAPE_DEFAULT_THRESHOLDS: LandscapeThresholds = {
  minSelectedCount: 3,
  minFeedbackCount: 3,
  feedbackConfidence: {
    mediumMin: 10,
    highMin: 30,
  },
  feedbackFactor: {
    insufficient: 0.4,
    low: 0.7,
    medium: 0.9,
    high: 1,
  },
  attractor: {
    strongUsedRateMin: 0.7,
    usefulUsedRateMin: 0.5,
    strongSourceRefDensityMin: 0.6,
  },
  negative: {
    offTopicWeight: 1,
    wrongWeight: 3,
    candidateOffTopicRateMin: 0.4,
  },
  notUsed: {
    overSelectedRateMin: 0.6,
  },
  deadZone: {
    reachabilityRiskMin: 0.3,
    staleSourceRefDensityMax: 0.5,
    staleFactorMin: 0.5,
  },
  evidenceFactor: {
    sourceRefDensityBaseline: 1,
    min: 0.25,
    max: 1.25,
  },
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function maxOne(value: number): number {
  return Math.max(1, value);
}

function round(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1000) / 1000;
}

function rate(value: number, total: number): number {
  return round(value / maxOne(total));
}

function deriveFeedbackConfidence(
  feedbackCount: number,
  minFeedbackCount: number,
  thresholds: LandscapeThresholds,
): LandscapeFeedbackConfidence {
  if (feedbackCount < minFeedbackCount) return "insufficient";
  if (feedbackCount < thresholds.feedbackConfidence.mediumMin) return "low";
  if (feedbackCount < thresholds.feedbackConfidence.highMin) return "medium";
  return "high";
}

function feedbackConfidenceFactor(
  confidence: LandscapeFeedbackConfidence,
  thresholds: LandscapeThresholds,
): number {
  return thresholds.feedbackFactor[confidence];
}

function classify(params: {
  input: ScoreInput;
  thresholds: LandscapeThresholds;
  feedbackCountWindow: number;
  feedbackConfidence: LandscapeFeedbackConfidence;
  usedRate: number;
  notUsedRate: number;
  offTopicRate: number;
  wrongRate: number;
  reachabilityRiskScore: number;
}): {
  primary: LandscapeClassificationPrimary;
  flags: string[];
  confidence: LandscapeClassificationConfidence;
  reason: string;
  recommendedActions: string[];
} {
  const { input, thresholds } = params;
  const flags: string[] = [];
  const recommendedActions: string[] = [];

  if (params.input.wrongCountWindow > 0) {
    flags.push("wrong_review_required");
  }
  if (params.feedbackConfidence === "insufficient") {
    flags.push("feedback_insufficient");
  }

  let primary: LandscapeClassificationPrimary = "neutral";
  if (
    input.selectedItemCountWindow >= input.minSelectedCount &&
    params.feedbackConfidence !== "insufficient" &&
    (params.offTopicRate >= thresholds.negative.candidateOffTopicRateMin ||
      input.wrongCountWindow > 0)
  ) {
    primary = "negative_attractor_candidate";
    recommendedActions.push("appliesTo の適用範囲を見直して off_topic 比率を下げる");
    if (input.wrongCountWindow > 0) {
      recommendedActions.push("wrong 判定イベントを起点にレビューキューを処理する");
    }
  } else if (
    input.selectedItemCountWindow >= input.minSelectedCount &&
    params.feedbackConfidence !== "insufficient" &&
    params.notUsedRate >= thresholds.notUsed.overSelectedRateMin &&
    input.offTopicCountWindow === 0 &&
    input.wrongCountWindow === 0
  ) {
    primary = "over_selected_not_used";
    recommendedActions.push("選出されるが未使用の知識を分割し、検索スコープを調整する");
  } else if (input.selectedItemCountWindow > 0 && params.feedbackConfidence === "insufficient") {
    primary = "feedback_insufficient";
    recommendedActions.push("判定件数が少ないため運用フィードバックを追加して評価を安定化する");
  } else if (
    input.selectedItemCountWindow >= input.minSelectedCount &&
    FEEDBACK_CONFIDENCE_ORDER[params.feedbackConfidence] >= FEEDBACK_CONFIDENCE_ORDER.medium &&
    params.usedRate >= thresholds.attractor.strongUsedRateMin &&
    input.sourceRefDensity >= thresholds.attractor.strongSourceRefDensityMin
  ) {
    primary = "strong_attractor";
    recommendedActions.push("高品質コミュニティとして維持し、周辺知識の根拠リンクを増やす");
  } else if (
    input.selectedItemCountWindow >= input.minSelectedCount &&
    params.usedRate >= thresholds.attractor.usefulUsedRateMin &&
    input.offTopicCountWindow === 0 &&
    input.wrongCountWindow === 0
  ) {
    primary = "useful_attractor";
    recommendedActions.push("現在の適用範囲を維持しつつフィードバック件数を増やす");
  } else if (
    input.activeCount > 0 &&
    input.selectedItemCountWindow === 0 &&
    input.cumulativeCompileSelectCount === 0 &&
    params.reachabilityRiskScore >= thresholds.deadZone.reachabilityRiskMin
  ) {
    primary = "dead_zone_reachability_risk";
    recommendedActions.push("title / body / appliesTo を調整して到達性を改善する");
  } else if (
    input.activeCount > 0 &&
    input.selectedItemCountWindow === 0 &&
    input.sourceRefDensity < thresholds.deadZone.staleSourceRefDensityMax &&
    input.avgStalenessFactor >= thresholds.deadZone.staleFactorMin
  ) {
    primary = "dead_zone_stale";
    recommendedActions.push("根拠不足かつ陳腐化した知識の統合・整理を検討する");
  } else {
    recommendedActions.push("現状維持。必要時に追加データを観測して再評価する");
  }

  let confidence: LandscapeClassificationConfidence = "medium";
  if (primary === "feedback_insufficient") {
    confidence = "low";
  } else if (primary === "negative_attractor_candidate") {
    confidence =
      input.wrongCountWindow > 0 || params.feedbackConfidence === "high" ? "high" : "medium";
  } else if (primary === "strong_attractor") {
    confidence = params.feedbackConfidence === "high" ? "high" : "medium";
  } else if (primary === "useful_attractor") {
    confidence = params.feedbackConfidence === "insufficient" ? "low" : "medium";
  } else if (primary === "dead_zone_reachability_risk") {
    confidence =
      params.reachabilityRiskScore >= thresholds.deadZone.reachabilityRiskMin + 0.2
        ? "high"
        : "medium";
  } else if (primary === "neutral") {
    confidence = input.selectedItemCountWindow > 0 ? "medium" : "low";
  }

  const reason = (() => {
    switch (primary) {
      case "negative_attractor_candidate":
        return `選出${input.selectedItemCountWindow}件に対して off_topic=${Math.round(params.offTopicRate * 100)}% / wrong=${input.wrongCountWindow}。`;
      case "over_selected_not_used":
        return `not_used 比率が ${Math.round(params.notUsedRate * 100)}% と高く、negative 判定は未観測。`;
      case "strong_attractor":
        return `used 比率 ${Math.round(params.usedRate * 100)}%、根拠密度 ${round(input.sourceRefDensity)}。`;
      case "useful_attractor":
        return `used 比率 ${Math.round(params.usedRate * 100)}% で安定。`;
      case "dead_zone_reachability_risk":
        return "active 知識が未選出で、到達性リスクが高い。";
      case "dead_zone_stale":
        return "未選出かつ根拠密度が低く、鮮度も低い。";
      case "feedback_insufficient":
        return `選出はあるが feedback 件数 ${params.feedbackCountWindow} が閾値未満。`;
      default:
        return "現在の分類を決めるだけの強いシグナルが不足。";
    }
  })();

  return { primary, flags, confidence, reason, recommendedActions };
}

export function scoreLandscapeCommunity(
  input: ScoreInput,
  thresholds: LandscapeThresholds = LANDSCAPE_DEFAULT_THRESHOLDS,
): ScoreResult {
  const feedbackCountWindow =
    input.usedCountWindow +
    input.notUsedCountWindow +
    input.offTopicCountWindow +
    input.wrongCountWindow;
  const feedbackConfidence = deriveFeedbackConfidence(
    feedbackCountWindow,
    input.minFeedbackCount,
    thresholds,
  );
  const feedbackFactor = feedbackConfidenceFactor(feedbackConfidence, thresholds);

  const usedRate = rate(input.usedCountWindow, feedbackCountWindow);
  const notUsedRate = rate(input.notUsedCountWindow, feedbackCountWindow);
  const offTopicRate = rate(input.offTopicCountWindow, feedbackCountWindow);
  const wrongRate = rate(input.wrongCountWindow, feedbackCountWindow);

  const positiveRate = usedRate;
  const evidenceFactor = clamp(
    input.sourceRefDensity / thresholds.evidenceFactor.sourceRefDensityBaseline,
    thresholds.evidenceFactor.min,
    thresholds.evidenceFactor.max,
  );
  const attractorScore = round(
    input.selectedItemCountWindow *
      positiveRate *
      evidenceFactor *
      clamp(input.avgFreshnessFactor, 0, 1) *
      feedbackFactor,
  );

  const negativeWeighted =
    input.offTopicCountWindow * thresholds.negative.offTopicWeight +
    input.wrongCountWindow * thresholds.negative.wrongWeight;
  const negativeRate = negativeWeighted / maxOne(feedbackCountWindow);
  const negativeScore = round(input.selectedItemCountWindow * negativeRate * feedbackFactor);

  const zeroUseActiveRatio = input.zeroUseActiveCount / maxOne(input.activeCount);
  const sourceEvidenceFactor =
    input.sourceRefDensity >= 1 ? 1 : input.sourceRefDensity >= 0.5 ? 0.6 : 0.2;
  const qualityPotential = (input.avgImportance + input.avgConfidence) / 2 / 100;
  const reachabilityRiskScore = round(
    zeroUseActiveRatio * sourceEvidenceFactor * qualityPotential * input.embeddedRatio,
  );

  const classification = classify({
    input,
    thresholds,
    feedbackCountWindow,
    feedbackConfidence,
    usedRate,
    notUsedRate,
    offTopicRate,
    wrongRate,
    reachabilityRiskScore,
  });

  return {
    feedbackCountWindow,
    feedbackConfidence,
    usedRate,
    notUsedRate,
    offTopicRate,
    wrongRate,
    attractorScore,
    negativeScore,
    reachabilityRiskScore,
    classification: {
      primary: classification.primary,
      flags: classification.flags,
      confidence: classification.confidence,
      reason: classification.reason,
    },
    recommendedActions: classification.recommendedActions,
  };
}
