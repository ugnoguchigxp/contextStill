type ManualPauseLike = {
  lastError?: unknown;
  metadata?: unknown;
};

function hasManualPauseToken(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized.startsWith("manual_pause") || normalized.includes("manual pause");
}

export function isManualPauseReason(reason: unknown): boolean {
  return hasManualPauseToken(reason);
}

export function isManualPauseTarget(target: ManualPauseLike): boolean {
  if (hasManualPauseToken(target.lastError)) return true;
  const metadata = target.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  const record = metadata as Record<string, unknown>;
  if (record.manualPause === true) return true;
  return (
    hasManualPauseToken(record.pauseReason) ||
    hasManualPauseToken(record.reason) ||
    hasManualPauseToken(record.lastError)
  );
}
