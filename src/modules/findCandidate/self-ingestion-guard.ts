export const CODEX_FINDING_ESCALATION_GENERATED_BY = "contextStill.codexFindingEscalation";

export function parseMetadataRecord(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function isCodexFindingEscalationMetadata(metadata: unknown): boolean {
  const record = parseMetadataRecord(metadata);
  return (
    record.generatedBy === CODEX_FINDING_ESCALATION_GENERATED_BY ||
    record.excludedFromVibeMemory === true ||
    record.excludeFromFindingCandidate === true
  );
}
