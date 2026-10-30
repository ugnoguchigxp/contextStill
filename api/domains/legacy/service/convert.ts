import type { Scope } from "../../../infrastructure/scope";

/** Parses legacy JSON text; a value that is not valid JSON falls back to `fallback`. */
export function parseJson<T>(text: string | null | undefined, fallback: T): T {
	if (text === null || text === undefined || text === "") return fallback;
	try {
		return JSON.parse(text) as T;
	} catch {
		return fallback;
	}
}

export function parseObject(
	text: string | null | undefined,
): Record<string, unknown> {
	const value = parseJson<unknown>(text, {});
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

export function parseArray(text: string | null | undefined): unknown[] {
	const value = parseJson<unknown>(text, []);
	return Array.isArray(value) ? value : [];
}

/** Legacy 0-100 scores to 0-1 (clamped; non-finite values become 0). */
export function percentToUnit(value: number | null | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 0;
	return Math.min(1, Math.max(0, value / 100));
}

function blankToNull(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

const lastSegment = (value: string): string => {
	const trimmed = value.replace(/\/+$/, "");
	return trimmed.slice(trimmed.lastIndexOf("/") + 1);
};

/**
 * The repo key of the new version. A legacy `repo_key` is a path (`/a/b/name`), `owner/name`
 * or already a name, so its last segment is the name; when it is empty the name comes from
 * `repo_path`. Always lowercase; null when neither gives a name.
 */
export function canonicalRepoKey(
	repoKey: string | null | undefined,
	repoPath: string | null | undefined,
): string | null {
	for (const source of [repoKey, repoPath]) {
		const trimmed = blankToNull(source);
		if (!trimmed) continue;
		const name = lastSegment(trimmed).trim().toLowerCase();
		if (name) return name;
	}
	return null;
}

/**
 * Legacy scope to the new one. `global` stays global. `repo` becomes a repo-scoped row when a
 * repo key can be derived from `repo_key` or `repo_path`; `repo` with neither is a row the
 * legacy classifier could not place, so it becomes `global` (the legacy value stays in the
 * metadata). Unknown scopes are refused (null) rather than guessed.
 */
export function normalizeScope(
	scope: string | null | undefined,
	repoKey: string | null | undefined,
	repoPath: string | null | undefined,
): { scope: Scope; repoKey: string | null } | null {
	if (scope === "global") return { scope: "global", repoKey: null };
	if (scope === "repo") {
		const key = canonicalRepoKey(repoKey, repoPath);
		return key
			? { scope: "repo", repoKey: key }
			: { scope: "global", repoKey: null };
	}
	return null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
