import type {
  ContextDecisionConfidenceTrace,
  ContextDecisionInput,
} from "../../shared/schemas/context-decision.schema.js";
import type { DecisionEvidenceCandidate } from "./context-decision.scoring.js";

export const contextDecisionMlFeatureVersion = "context-decision-ml-features-v1" as const;

export const contextDecisionMlFeatureNames = [
  "supportHitCount",
  "preferenceHitCount",
  "riskHitCount",
  "counterEvidenceHitCount",
  "selectedSupportCount",
  "selectedPreferenceCount",
  "selectedRiskCount",
  "supportScore",
  "counterScore",
  "preferenceScore",
  "riskSignalScore",
  "coverageScore",
  "verificationScore",
  "historicalFeedbackScore",
  "deterministicConfidence",
  "relatedBadSignalCount",
  "technologyHintCount",
  "changeTypeHintCount",
  "domainHintCount",
  "hasSessionId",
  "metadataHasBranch",
  "metadataHasPr",
  "metadataHasHeadSha",
] as const;

export type ContextDecisionMlFeatureName = (typeof contextDecisionMlFeatureNames)[number];
export type ContextDecisionMlFeatures = Record<ContextDecisionMlFeatureName, number>;

type CoverageFeatureInput = {
  queryRole: string;
  hitCount: number;
};

function finite(value: unknown): number {
  const numberValue = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

function bool(value: boolean): number {
  return value ? 1 : 0;
}

function metadataHasAny(metadata: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => {
    const value = metadata[key];
    return typeof value === "string" ? value.trim().length > 0 : value != null;
  });
}

function coverageHitCount(coverage: CoverageFeatureInput[], role: string): number {
  return coverage
    .filter((item) => item.queryRole === role)
    .reduce((sum, item) => sum + finite(item.hitCount), 0);
}

export function buildContextDecisionMlFeatures(params: {
  input: ContextDecisionInput;
  evidence: DecisionEvidenceCandidate[];
  coverage: CoverageFeatureInput[];
  trace: ContextDecisionConfidenceTrace;
  relatedBadSignalCount: number;
}): ContextDecisionMlFeatures {
  const metadata = params.input.metadata ?? {};
  const features: ContextDecisionMlFeatures = {
    supportHitCount: coverageHitCount(params.coverage, "support"),
    preferenceHitCount: coverageHitCount(params.coverage, "user_preference"),
    riskHitCount: coverageHitCount(params.coverage, "risk"),
    counterEvidenceHitCount: coverageHitCount(params.coverage, "counter_evidence"),
    selectedSupportCount: params.evidence.filter((item) => item.role === "selected_support").length,
    selectedPreferenceCount: params.evidence.filter((item) => item.role === "user_preference")
      .length,
    selectedRiskCount: params.evidence.filter((item) => item.role === "risk_warning").length,
    supportScore: finite(params.trace.supportScore),
    counterScore: finite(params.trace.counterScore),
    preferenceScore: finite(params.trace.preferenceScore),
    riskSignalScore: finite(params.trace.riskSignalScore),
    coverageScore: finite(params.trace.coverageScore),
    verificationScore: finite(params.trace.verificationScore),
    historicalFeedbackScore: finite(params.trace.historicalFeedbackScore),
    deterministicConfidence: finite(params.trace.finalConfidence),
    relatedBadSignalCount: finite(params.relatedBadSignalCount),
    technologyHintCount: params.input.retrievalHints.technologies.length,
    changeTypeHintCount: params.input.retrievalHints.changeTypes.length,
    domainHintCount: params.input.retrievalHints.domains.length,
    hasSessionId: bool(Boolean(params.input.sessionId)),
    metadataHasBranch: bool(metadataHasAny(metadata, ["branch", "headRefName"])),
    metadataHasPr: bool(metadataHasAny(metadata, ["prUrl", "prNumber"])),
    metadataHasHeadSha: bool(metadataHasAny(metadata, ["headSha", "headRefOid"])),
  };
  return normalizeContextDecisionMlFeatures(features);
}

export function normalizeContextDecisionMlFeatures(
  value: Record<string, unknown>,
): ContextDecisionMlFeatures {
  return Object.fromEntries(
    contextDecisionMlFeatureNames.map((name) => [name, finite(value[name])]),
  ) as ContextDecisionMlFeatures;
}

export function readContextDecisionMlFeaturesFromTrace(
  trace: Record<string, unknown>,
): ContextDecisionMlFeatures | null {
  const mlSignal = trace.mlSignal;
  if (!mlSignal || typeof mlSignal !== "object" || Array.isArray(mlSignal)) return null;
  const features = (mlSignal as Record<string, unknown>).features;
  if (!features || typeof features !== "object" || Array.isArray(features)) return null;
  const featureRecord = features as Record<string, unknown>;
  if (!contextDecisionMlFeatureNames.every((name) => name in featureRecord)) return null;
  return normalizeContextDecisionMlFeatures(featureRecord);
}

export function contextDecisionMlFeatureVector(features: ContextDecisionMlFeatures): number[] {
  return contextDecisionMlFeatureNames.map((name) => features[name]);
}
