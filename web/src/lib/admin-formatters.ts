import { formatDateTimeShort } from "./timezone";

export function formatCheckedAt(value: string | null | undefined, timezone: string): string {
  return formatDateTimeShort(value, timezone);
}

export function formatNumber(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatPercent(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return `${(value * 100).toFixed(1)}%`;
}
