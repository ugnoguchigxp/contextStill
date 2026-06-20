import { type KnowledgeApplicability, normalizeApplicability } from "../knowledge/applicability.js";

export type NegativeEvidenceAppliesTo = KnowledgeApplicability;

export type NegativeEvidenceResult = {
  status: "ready" | "insufficient" | "false_positive" | "not_reusable";
  polarity: "negative" | "neutral";
  intentTags: string[];
  appliesTo?: NegativeEvidenceAppliesTo;
  distilled: {
    failure: string;
    impact?: string;
    trigger?: string;
    fix?: string;
    verification?: string;
    decisionSignal?: string;
  };
  evidence: string[];
  originRefs: string[];
};

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value))
    return value
      .map(String)
      .map((item) => item.trim())
      .filter(Boolean);
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

export function parseNegativeEvidenceResult(text: string): NegativeEvidenceResult {
  const cleanText = text
    .replace(/```json/g, "")
    .replace(/```/g, "")
    .trim();
  try {
    const parsed = JSON.parse(cleanText);
    if (!parsed.status || !parsed.polarity || !parsed.distilled || !parsed.distilled.failure) {
      throw new Error("Missing required fields in parsed JSON");
    }
    const appliesTo = normalizeApplicability(parsed.appliesTo ?? parsed.applicability);
    return {
      status: parsed.status,
      polarity: parsed.polarity,
      intentTags: asStringArray(parsed.intentTags),
      ...(appliesTo ? { appliesTo } : {}),
      distilled: {
        failure: String(parsed.distilled.failure),
        impact: parsed.distilled.impact ? String(parsed.distilled.impact) : undefined,
        trigger: parsed.distilled.trigger ? String(parsed.distilled.trigger) : undefined,
        fix: parsed.distilled.fix ? String(parsed.distilled.fix) : undefined,
        verification: parsed.distilled.verification
          ? String(parsed.distilled.verification)
          : undefined,
        decisionSignal: parsed.distilled.decisionSignal
          ? String(parsed.distilled.decisionSignal)
          : undefined,
      },
      evidence: asStringArray(parsed.evidence),
      originRefs: asStringArray(parsed.originRefs),
    };
  } catch (error) {
    throw new Error(
      `Failed to parse negative evidence result JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
