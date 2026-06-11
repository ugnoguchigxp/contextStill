export type NegativeEvidenceResult = {
  status: "ready" | "insufficient" | "false_positive" | "not_reusable";
  polarity: "negative" | "neutral";
  intentTags: string[];
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
    return {
      status: parsed.status,
      polarity: parsed.polarity,
      intentTags: Array.isArray(parsed.intentTags) ? parsed.intentTags.map(String) : [],
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
      evidence: Array.isArray(parsed.evidence) ? parsed.evidence.map(String) : [],
      originRefs: Array.isArray(parsed.originRefs) ? parsed.originRefs.map(String) : [],
    };
  } catch (error) {
    throw new Error(
      `Failed to parse negative evidence result JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
