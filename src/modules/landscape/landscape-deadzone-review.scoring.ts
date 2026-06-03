import type {
  DeadZoneApplicabilityMatch,
  DeadZoneEvidenceStrength,
  DeadZoneGraphHealth,
  DeadZoneKnowledgeReviewBadge,
  DeadZoneSuggestedAction,
  DeadZoneStructureQuality,
  DeadZoneUsageStrength,
} from "../../shared/schemas/landscape-deadzone-review.schema.js";

export type DeadZoneScoringKnowledge = {
  id: string;
  type: "rule" | "procedure";
  status: "draft" | "active" | "deprecated";
  body: string;
  appliesTo: Record<string, unknown>;
  metadata: Record<string, unknown>;
  compileSelectCount: number;
  lastCompiledAt: Date | null;
  sourceRefCount: number;
  originRefCount: number;
  sourceRefDensity: number;
  embedded: boolean;
};

function normalizeToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function tokenSet(record: Record<string, unknown>, key: string): Set<string> {
  const value = record[key];
  if (!Array.isArray(value)) return new Set();
  return new Set(value.map(normalizeToken).filter((token): token is string => Boolean(token)));
}

function scalarToken(record: Record<string, unknown>, key: string): string | null {
  return normalizeToken(record[key]);
}

function jaccard(left: Set<string>, right: Set<string>): number | null {
  if (left.size === 0 && right.size === 0) return null;
  const union = new Set([...left, ...right]);
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  return union.size === 0 ? null : intersection / union.size;
}

function scalarScore(left: string | null, right: string | null): number | null {
  if (!left && !right) return null;
  if (!left || !right) return 0;
  return left === right ? 1 : 0;
}

export function scoreApplicabilityMatch(
  left: Pick<DeadZoneScoringKnowledge, "appliesTo" | "metadata">,
  right: Pick<DeadZoneScoringKnowledge, "appliesTo" | "metadata">,
): { score: number; label: DeadZoneApplicabilityMatch; reasons: string[] } {
  const scoreParts: number[] = [];
  const reasons: string[] = [];
  for (const key of ["domains", "technologies", "changeTypes"] as const) {
    const score = jaccard(tokenSet(left.appliesTo, key), tokenSet(right.appliesTo, key));
    if (score !== null) {
      scoreParts.push(score);
      if (score < 0.4) reasons.push(`${key} differs`);
    }
  }
  for (const key of ["repoKey", "repoPath"] as const) {
    const leftValue = scalarToken(left.appliesTo, key) ?? scalarToken(left.metadata, key);
    const rightValue = scalarToken(right.appliesTo, key) ?? scalarToken(right.metadata, key);
    const score = scalarScore(leftValue, rightValue);
    if (score !== null) {
      scoreParts.push(score);
      if (score === 0) reasons.push(`${key} differs`);
    }
  }
  const score =
    scoreParts.length > 0
      ? scoreParts.reduce((sum, value) => sum + value, 0) / scoreParts.length
      : 0.5;
  const label: DeadZoneApplicabilityMatch =
    score >= 0.75 ? "high" : score >= 0.4 ? "medium" : "low";
  if (label === "high") reasons.unshift("applicability aligns");
  if (label === "medium") reasons.unshift("applicability partially overlaps");
  if (label === "low") reasons.unshift("applicability scope differs");
  return { score, label, reasons };
}

export function scoreEvidenceStrength(input: {
  sourceRefCount: number;
  originRefCount: number;
  sourceRefDensity: number;
}): DeadZoneEvidenceStrength {
  const refCount = input.sourceRefCount + input.originRefCount;
  if (refCount <= 0 && input.sourceRefDensity < 0.5) return "none";
  if (refCount >= 2 || input.sourceRefDensity >= 1) return "strong";
  if (refCount >= 1 || input.sourceRefDensity >= 0.5) return "moderate";
  return "thin";
}

export function scoreUsageStrength(input: {
  compileSelectCount: number;
  lastCompiledAt: Date | null;
}): DeadZoneUsageStrength {
  if (input.compileSelectCount >= 3) return "strong";
  if (input.compileSelectCount > 0) return "moderate";
  if (input.lastCompiledAt) return "low";
  return "none";
}

export function scoreStructureQuality(input: {
  type: "rule" | "procedure";
  body: string;
}): DeadZoneStructureQuality {
  const body = input.body.toLowerCase();
  const lengthScore =
    input.body.trim().length >= 240 ? 1 : input.body.trim().length >= 120 ? 0.5 : 0;
  if (input.type === "procedure") {
    const sectionCount = ["use when", "workflow", "verification", "avoid"].filter((section) =>
      body.includes(section),
    ).length;
    if (sectionCount >= 3 && lengthScore >= 0.5) return "strong";
    if (sectionCount >= 1 || lengthScore >= 0.5) return "partial";
    return "weak";
  }
  if (lengthScore >= 1) return "strong";
  if (lengthScore >= 0.5) return "partial";
  return "weak";
}

export function scoreGraphHealth(input: {
  communitySize: number;
  sourceRefDensity: number;
}): DeadZoneGraphHealth {
  if (input.communitySize <= 1) return "orphan";
  if (input.sourceRefDensity < 0.6) return "thin";
  return "connected";
}

export function suggestedActionForSimilar(input: {
  deadZoneEvidence: DeadZoneEvidenceStrength;
  deadZoneUsage: DeadZoneUsageStrength;
  similarEvidence: DeadZoneEvidenceStrength;
  similarUsage: DeadZoneUsageStrength;
  applicabilityMatch: DeadZoneApplicabilityMatch;
  similarity: number;
  similarStatus: "draft" | "active" | "deprecated";
}): { action: DeadZoneSuggestedAction; reasons: string[] } {
  const reasons: string[] = [`similarity ${Math.round(input.similarity * 100)}%`];
  if (input.similarStatus === "deprecated") {
    return { action: "keep_separate", reasons: [...reasons, "similar knowledge is deprecated"] };
  }
  if (input.applicabilityMatch === "low") {
    return { action: "scope_differs", reasons: [...reasons, "applicability scope differs"] };
  }
  if (input.deadZoneEvidence === "none" || input.deadZoneEvidence === "thin") {
    if (input.similarEvidence === "strong" || input.similarEvidence === "moderate") {
      return {
        action: "merge_into_similar",
        reasons: [...reasons, "similar knowledge has stronger evidence"],
      };
    }
    return { action: "needs_evidence", reasons: [...reasons, "DeadZone evidence is thin"] };
  }
  if (input.deadZoneUsage === "strong" || input.deadZoneEvidence === "strong") {
    return {
      action: "deadzone_is_canonical",
      reasons: [...reasons, "DeadZone knowledge has stronger retention signals"],
    };
  }
  if (input.applicabilityMatch === "high" && input.similarity >= 0.94) {
    return { action: "likely_duplicate", reasons: [...reasons, "high similarity and scope match"] };
  }
  return { action: "keep_separate", reasons: [...reasons, "requires human review"] };
}

export function deriveDeadZoneReviewBadges(input: {
  knowledge: DeadZoneScoringKnowledge;
  evidenceStrength: DeadZoneEvidenceStrength;
  usageStrength: DeadZoneUsageStrength;
  structureQuality: DeadZoneStructureQuality;
  graphHealth: DeadZoneGraphHealth;
  similarActions: DeadZoneSuggestedAction[];
}): DeadZoneKnowledgeReviewBadge[] {
  const badges = new Set<DeadZoneKnowledgeReviewBadge>();
  if (!input.knowledge.embedded) badges.add("Needs embedding");
  if (input.similarActions.includes("merge_into_similar")) badges.add("Strong merge candidate");
  if (input.similarActions.includes("deadzone_is_canonical")) badges.add("Canonical candidate");
  if (input.similarActions.includes("likely_duplicate")) badges.add("Likely duplicate");
  if (input.similarActions.includes("scope_differs")) badges.add("Scope differs");
  if (input.evidenceStrength === "none" || input.evidenceStrength === "thin") {
    badges.add("Evidence thin");
  }
  if (input.usageStrength === "none" && input.structureQuality !== "strong") badges.add("Stale");
  if (input.graphHealth === "orphan" && input.evidenceStrength !== "none") {
    badges.add("Niche but valid");
  }
  if (badges.size === 0) badges.add("Niche but valid");
  return [...badges];
}
