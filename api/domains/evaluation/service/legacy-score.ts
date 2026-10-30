// Port of the v1 lexical scorer (native_common.rs::score_text / normalized_query_tokens).

const MAX_TOKENS = 48;
// Rust: `!c.is_alphanumeric() && c != '_' && c != '-'` splits; letters and numbers stay.
const TOKEN_SPLIT = /[^\p{L}\p{N}_-]+/u;

const charCount = (value: string) => [...value].length;

/**
 * Whole tokens first (2+ chars, deduped), then for tokens that contain a non-ASCII
 * character the width-3 and width-2 character n-grams, cut at 48 entries.
 */
export function legacyQueryTokens(query: string): string[] {
	const tokens = query
		.trim()
		.toLowerCase()
		.split(TOKEN_SPLIT)
		.map((token) => token.trim())
		.filter((token) => charCount(token) >= 2);
	const seen = new Set<string>();
	const normalized: string[] = [];
	const push = (token: string) => {
		if (seen.has(token)) return;
		seen.add(token);
		normalized.push(token);
	};
	for (const token of tokens) push(token);
	for (const token of tokens) {
		const characters = [...token];
		if (!characters.some((character) => character.charCodeAt(0) > 0x7f))
			continue;
		for (const width of [3, 2])
			for (let i = 0; i + width <= characters.length; i++)
				push(characters.slice(i, i + width).join(""));
	}
	return normalized.slice(0, MAX_TOKENS);
}

/** A query prepared once and scored against many texts. */
export function prepareLegacyQuery(query: string) {
	const trimmed = query.trim().toLowerCase();
	const tokens = trimmed === "" ? [] : legacyQueryTokens(trimmed);
	return (value: string): number => {
		if (trimmed === "") return 0;
		const text = value.toLowerCase();
		let score = text.includes(trimmed) ? 4 : 0;
		for (const token of tokens) if (text.includes(token)) score += 1;
		return score;
	};
}

/** +4 when the whole query is contained in the text, +1 for each contained token. */
export function legacyScoreText(value: string, query: string): number {
	return prepareLegacyQuery(query)(value);
}
