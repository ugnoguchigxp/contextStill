export type TimeFormat = "iso" | "sqlite" | "unix_ms" | "invalid";

const UNIX_MS = /^unix-ms:(\d{1,15})$/;
const SQLITE =
	/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?$/;
function sqliteToDate(value: string): Date | null {
	const m = SQLITE.exec(value);
	if (!m) return null;
	const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number) as [
		number,
		number,
		number,
		number,
		number,
		number,
	];
	const ms = Number((m[7] ?? "").padEnd(3, "0").slice(0, 3) || 0);
	const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s, ms));
	// Date.UTC wraps overflowing fields (month 13, day 31 of a 30-day month).
	if (
		date.getUTCFullYear() !== y ||
		date.getUTCMonth() !== mo - 1 ||
		date.getUTCDate() !== d ||
		date.getUTCHours() !== h ||
		date.getUTCMinutes() !== mi ||
		date.getUTCSeconds() !== s
	)
		return null;
	return date;
}

const ISO_PARTS =
	/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})?$/;

function isoToDate(value: string): Date | null {
	const m = ISO_PARTS.exec(value);
	if (!m) return null;
	const [y, mo, d, h, mi] = m.slice(1, 6).map(Number) as [
		number,
		number,
		number,
		number,
		number,
	];
	const s = Number(m[6] ?? 0);
	const ms = Number((m[7] ?? "").padEnd(3, "0").slice(0, 3) || 0);
	// The calendar fields must survive a round trip: Date.UTC would roll 02-31 into March.
	const check = new Date(Date.UTC(y, mo - 1, d, h, mi, s, ms));
	if (
		check.getUTCFullYear() !== y ||
		check.getUTCMonth() !== mo - 1 ||
		check.getUTCDate() !== d ||
		check.getUTCHours() !== h ||
		check.getUTCMinutes() !== mi ||
		check.getUTCSeconds() !== s
	)
		return null;
	const zone = m[8];
	if (zone && zone !== "Z") {
		const offsetHours = Number(zone.slice(1, 3));
		const offsetMinutes = Number(zone.slice(4, 6));
		if (offsetHours > 23 || offsetMinutes > 59) return null;
	}
	// An offset-less ISO string is read as UTC, like SQLite's CURRENT_TIMESTAMP.
	const date = new Date(zone ? value : `${value}Z`);
	return Number.isNaN(date.getTime()) ? null : date;
}

export function classifyTime(value: string): TimeFormat {
	if (UNIX_MS.test(value)) {
		const ms = Number(UNIX_MS.exec(value)![1]);
		return Number.isNaN(new Date(ms).getTime()) ? "invalid" : "unix_ms";
	}
	if (sqliteToDate(value)) return "sqlite";
	if (isoToDate(value)) return "iso";
	return "invalid";
}

/** Legacy timestamps to UTC ISO (`toISOString()` form); null when not understood. */
export function toUtcIso(value: string | null | undefined): string | null {
	if (value === null || value === undefined) return null;
	const text = value.trim();
	const unix = UNIX_MS.exec(text);
	if (unix) {
		const date = new Date(Number(unix[1]));
		return Number.isNaN(date.getTime()) ? null : date.toISOString();
	}
	return (sqliteToDate(text) ?? isoToDate(text))?.toISOString() ?? null;
}
