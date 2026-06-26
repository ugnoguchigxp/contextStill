export function nowIso(): string {
  return new Date().toISOString();
}

export function timestampToIso(raw: unknown): string | null {
  if (raw instanceof Date) {
    const timestamp = raw.getTime();
    return Number.isFinite(timestamp) ? raw.toISOString() : null;
  }
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? new Date(raw).toISOString() : null;
  }
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const unixMillis = trimmed.startsWith("unix-ms:")
    ? Number(trimmed.slice("unix-ms:".length))
    : Number.NaN;
  if (Number.isFinite(unixMillis)) return new Date(unixMillis).toISOString();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(trimmed)) {
    const timestamp = Date.parse(`${trimmed.replace(" ", "T")}Z`);
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
  }
  const timestamp = Date.parse(trimmed);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export function minutesSince(iso: string): number {
  const timestamp = timestampToIso(iso);
  if (!timestamp) return 0;
  const deltaMs = Date.now() - new Date(timestamp).getTime();
  return Math.max(0, deltaMs / 1000 / 60);
}

export function cursorFileCount(raw: unknown): number {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return 0;
  return Object.keys(raw).length;
}

export function metadataWarnings(raw: unknown): string[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const warnings = (raw as { warnings?: unknown }).warnings;
  if (!Array.isArray(warnings)) return [];
  return warnings.filter((warning): warning is string => typeof warning === "string");
}

export function metadataSkipped(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  return Boolean((raw as { skipped?: unknown }).skipped);
}

export function metadataSyncedAt(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const syncedAt = (raw as { syncedAt?: unknown }).syncedAt;
  return timestampToIso(syncedAt);
}

export type ReasonCount = {
  reason: string;
  count: number;
};

export function normalizeReasonCounts(raw: unknown): ReasonCount[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item): ReasonCount | null => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const reason = (item as { reason?: unknown }).reason;
      const count = (item as { count?: unknown }).count;
      if (typeof reason !== "string" || !reason.trim()) return null;
      const normalizedCount = Number(count);
      if (!Number.isFinite(normalizedCount) || normalizedCount < 0) return null;
      return { reason, count: Math.trunc(normalizedCount) };
    })
    .filter((item): item is ReasonCount => item !== null);
}
