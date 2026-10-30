import { createHash } from "node:crypto";

export type HandleKind = "knowledge" | "episode";
export const HANDLE_PATTERN = /^(kn|ep)_[a-z2-7]{26}$/;

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** RFC 4648 base32, lowercase, without padding. */
function base32(bytes: Uint8Array): string {
	let bits = 0;
	let value = 0;
	let out = "";
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += ALPHABET[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
		value &= (1 << bits) - 1;
	}
	if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
	return out;
}

/** The only identifier that leaves the system. Deterministic for (kind, id). */
export function makeHandle(kind: HandleKind, id: string): string {
	const digest = createHash("sha256")
		.update(`contextstill:handle:v1:${kind}:${id}`)
		.digest()
		.subarray(0, 16);
	return `${kind === "knowledge" ? "kn_" : "ep_"}${base32(digest)}`;
}

export function handleKind(handle: string): HandleKind | null {
	if (!HANDLE_PATTERN.test(handle)) return null;
	return handle.startsWith("kn_") ? "knowledge" : "episode";
}
