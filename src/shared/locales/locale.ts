export type SupportedLocale = "en" | "ja";

export function resolveLocale(input?: string): SupportedLocale {
  if (!input) return "ja";
  const normalized = input.trim().toLowerCase();
  if (normalized === "en" || normalized.startsWith("en-")) return "en";
  if (normalized === "ja" || normalized.startsWith("ja-")) return "ja";
  return "ja";
}
