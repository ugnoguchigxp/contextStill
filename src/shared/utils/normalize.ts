type NormalizeStringArrayOptions = {
  lowercase?: boolean;
  sort?: boolean;
  dedupeCaseInsensitive?: boolean;
};

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function normalizeStringArray(
  value: unknown,
  options: NormalizeStringArrayOptions = {},
): string[] {
  const { lowercase = false, sort = true, dedupeCaseInsensitive = true } = options;
  const deduped = new Map<string, string>();
  for (const item of asStringArray(value)) {
    const key = dedupeCaseInsensitive ? item.toLowerCase() : item;
    if (deduped.has(key)) continue;
    deduped.set(key, lowercase ? key : item);
  }
  const values = [...deduped.values()];
  return sort ? values.sort((left, right) => left.localeCompare(right)) : values;
}

export function normalizeFacetArray(value: unknown): string[] {
  return normalizeStringArray(value, {
    lowercase: true,
    sort: true,
    dedupeCaseInsensitive: true,
  });
}

export function normalizeNullableString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function toIsoString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.length > 0) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date(0).toISOString();
}
