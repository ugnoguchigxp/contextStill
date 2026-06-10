import type {
  ContextDecisionFeedbackOutcome,
  ContextDecisionMlSignal,
  ContextDecisionValue,
} from "../../shared/schemas/context-decision.schema.js";
import { contextDecisionValueSchema } from "../../shared/schemas/context-decision.schema.js";
import type { ContextDecisionMlTrainingRow } from "./context-decision.repository.js";
import {
  contextDecisionMlFeatureVector,
  contextDecisionMlFeatureVersion,
  readContextDecisionMlFeaturesFromTrace,
  type ContextDecisionMlFeatures,
} from "./context-decision.ml-features.js";

const modelVersion = "ml-random-forest@2.1.0/context-decision-v1";
const minTrainingSamples = 30;
const minWinningConfidence = 0.6;

function baseSignal(params: {
  status: ContextDecisionMlSignal["status"];
  features: ContextDecisionMlFeatures;
  trainingSampleCount: number;
  classDistribution?: Record<string, number>;
  reason: string;
  predictedDecision?: ContextDecisionValue;
  confidence?: number;
}): ContextDecisionMlSignal {
  return {
    status: params.status,
    model: "ml-random-forest",
    modelVersion,
    featureVersion: contextDecisionMlFeatureVersion,
    predictedDecision: params.predictedDecision,
    confidence: params.confidence,
    trainingSampleCount: params.trainingSampleCount,
    classDistribution: params.classDistribution ?? {},
    features: params.features,
    reason: params.reason,
  };
}

function hasOutcome(row: ContextDecisionMlTrainingRow, outcomes: ContextDecisionFeedbackOutcome[]) {
  return row.systemOutcomes.some((outcome) => outcomes.includes(outcome));
}

function trainingLabel(row: ContextDecisionMlTrainingRow): ContextDecisionValue | null {
  if (row.humanFeedback === "good") return row.decision;
  if (row.humanFeedback === "bad") return "escalate";
  if (hasOutcome(row, ["still_unknown"])) return null;
  if (hasOutcome(row, ["failed", "discarded_pr", "user_overrode", "regression_found"])) {
    return "escalate";
  }
  if (hasOutcome(row, ["success"])) return row.decision;
  return null;
}

function classDistribution(labels: ContextDecisionValue[]): Record<string, number> {
  const distribution: Record<string, number> = {};
  for (const label of labels) {
    distribution[label] = (distribution[label] ?? 0) + 1;
  }
  return distribution;
}

function labelToId(label: ContextDecisionValue): number {
  return contextDecisionValueSchema.options.indexOf(label);
}

function idToLabel(id: number): ContextDecisionValue | null {
  return contextDecisionValueSchema.options[id] ?? null;
}

function voteConfidence(
  classifier: {
    predictionValues(toPredict: number[][]): { getRow(index: number): unknown[] };
  },
  vector: number[],
  predictedLabelId: number,
): number | null {
  const values = classifier.predictionValues([vector]).getRow(0);
  if (values.length === 0) return null;
  const votes = values.filter((value) => Number(value) === predictedLabelId).length;
  const confidence = votes / values.length;
  return Number.isFinite(confidence) ? confidence : null;
}

export async function buildContextDecisionMlSignal(input: {
  currentFeatures: ContextDecisionMlFeatures;
  trainingRows: ContextDecisionMlTrainingRow[];
  disabled?: boolean;
}): Promise<ContextDecisionMlSignal> {
  if (input.disabled) {
    return baseSignal({
      status: "disabled",
      features: input.currentFeatures,
      trainingSampleCount: 0,
      reason: "ML advisory signal is disabled.",
    });
  }

  const samples = input.trainingRows.flatMap((row) => {
    const label = trainingLabel(row);
    const features = readContextDecisionMlFeaturesFromTrace(row.confidenceTrace);
    return label && features ? [{ features, label }] : [];
  });
  const labels = samples.map((sample) => sample.label);
  const distribution = classDistribution(labels);

  if (samples.length < minTrainingSamples) {
    return baseSignal({
      status: "insufficient_data",
      features: input.currentFeatures,
      trainingSampleCount: samples.length,
      classDistribution: distribution,
      reason: `Need at least ${minTrainingSamples} labeled rows with persisted ML features.`,
    });
  }
  if (Object.keys(distribution).length < 2) {
    return baseSignal({
      status: "insufficient_data",
      features: input.currentFeatures,
      trainingSampleCount: samples.length,
      classDistribution: distribution,
      reason: "Need at least two label classes for Random Forest training.",
    });
  }

  try {
    const { RandomForestClassifier } = await import("ml-random-forest");
    const classifier = new RandomForestClassifier({
      seed: 13,
      nEstimators: 25,
      replacement: true,
      useSampleBagging: true,
      maxFeatures: 0.8,
      treeOptions: { maxDepth: 8, minNumSamples: 3 },
    });
    const trainingVectors = samples.map((sample) =>
      contextDecisionMlFeatureVector(sample.features),
    );
    const trainingLabels = labels.map(labelToId);
    classifier.train(trainingVectors, trainingLabels);

    const currentVector = contextDecisionMlFeatureVector(input.currentFeatures);
    const predictedLabelId = Number(classifier.predict([currentVector])[0]);
    const predictedDecision = idToLabel(predictedLabelId);
    if (!predictedDecision) {
      return baseSignal({
        status: "failed",
        features: input.currentFeatures,
        trainingSampleCount: samples.length,
        classDistribution: distribution,
        reason: "Random Forest returned an unknown decision label.",
      });
    }

    const probability = Number(classifier.predictProbability([currentVector], predictedLabelId)[0]);
    const fallbackProbability = Number.isFinite(probability)
      ? probability
      : voteConfidence(classifier, currentVector, predictedLabelId);
    const confidence = Number.isFinite(fallbackProbability)
      ? Number(fallbackProbability)
      : Number.NaN;
    if (!Number.isFinite(confidence)) {
      return baseSignal({
        status: "low_confidence",
        features: input.currentFeatures,
        trainingSampleCount: samples.length,
        classDistribution: distribution,
        predictedDecision,
        reason: "Random Forest could not produce a finite winning-label confidence.",
      });
    }
    if (confidence < minWinningConfidence) {
      return baseSignal({
        status: "low_confidence",
        features: input.currentFeatures,
        trainingSampleCount: samples.length,
        classDistribution: distribution,
        predictedDecision,
        confidence,
        reason: `Winning class confidence ${confidence.toFixed(3)} is below ${minWinningConfidence}.`,
      });
    }
    return baseSignal({
      status: "ready",
      features: input.currentFeatures,
      trainingSampleCount: samples.length,
      classDistribution: distribution,
      predictedDecision,
      confidence,
      reason: "Random Forest advisory signal is ready.",
    });
  } catch (error) {
    return baseSignal({
      status: "failed",
      features: input.currentFeatures,
      trainingSampleCount: samples.length,
      classDistribution: distribution,
      reason: error instanceof Error ? error.message : "Random Forest adapter failed.",
    });
  }
}
