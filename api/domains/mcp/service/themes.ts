import type { Database } from "bun:sqlite";
import { HANDLE_PATTERN } from "../../../infrastructure/handle";
import { getCluster, getClusterByHandle, listClusters } from "../../map";
import type { McpThemeRef } from "../contracts";

const THEME_LIMIT = 3;

/**
 * Resolves the `theme` input to a theme cluster id: a `th_…` handle, else an exact (trimmed) name,
 * else an exact alias. A name or alias shared by several themes is ambiguous and stays unresolved,
 * so the search is not narrowed to a guess.
 */
export function resolveThemeInput(db: Database, input: string): string | null {
	const text = input.trim();
	if (text === "") return null;
	if (HANDLE_PATTERN.test(text)) {
		const row = getClusterByHandle(db, text);
		return row && row.kind === "theme" && row.state !== "rejected"
			? row.id
			: null;
	}
	const themes = listClusters(db, { kind: "theme" }).filter(
		(t) => t.state !== "rejected",
	);
	for (const match of [
		(t: (typeof themes)[number]) => t.name === text,
		(t: (typeof themes)[number]) => t.aliases.includes(text),
	]) {
		const found = themes.filter(match);
		if (found.length === 1) return found[0]!.id;
		if (found.length > 1) return null;
	}
	return null;
}

/** The public form of a hit's theme ids: handle and name, at most three; unknown ids are dropped. */
export function themeRefs(
	db: Database,
	themeIds: readonly string[],
): McpThemeRef[] {
	const out: McpThemeRef[] = [];
	for (const id of themeIds) {
		if (out.length >= THEME_LIMIT) break;
		const row = getCluster(db, id);
		if (row && row.kind === "theme" && row.handle)
			out.push({ handle: row.handle, name: row.name });
	}
	return out;
}
