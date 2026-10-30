import { createHash } from "node:crypto";

export function sha256Hex(input: string | Uint8Array): string {
	return createHash("sha256").update(input).digest("hex");
}

/**
 * Stable JSON for persisted digests: object keys sorted in UTF-16 code unit
 * order, members whose value is `undefined` dropped. Output must stay
 * bit-identical forever (digests are stored).
 */
export function canonicalJson(value: unknown): string {
	const walk = (v: unknown): string => {
		if (Array.isArray(v)) return `[${v.map(walk).join(",")}]`;
		if (v && typeof v === "object") {
			const entries = Object.entries(v as Record<string, unknown>)
				.filter(([, x]) => x !== undefined)
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
			return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${walk(x)}`).join(",")}}`;
		}
		return JSON.stringify(v) ?? "null";
	};
	return walk(value);
}
