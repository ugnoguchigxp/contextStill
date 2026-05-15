export function nowIso(): string {
  return new Date().toISOString();
}

export function minutesSince(iso: string): number {
  const deltaMs = Date.now() - new Date(iso).getTime();
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
