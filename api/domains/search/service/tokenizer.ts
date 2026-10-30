const MAX_FTS_TERMS = 32;
const MAX_SHORT_TERMS = 8;
const MAX_JOINED_LENGTH = 12;

const CJK_WORD =
	/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー々]+$/u;
const HIRAGANA_ONLY = /^[\p{Script=Hiragana}ー]+$/u;
const segmenter = new Intl.Segmenter("ja", { granularity: "word" });

const length = (text: string) => [...text].length;

/**
 * Splits a query into FTS terms (3+ characters, usable with the trigram tokenizer) and
 * short terms (exactly 2 characters, handled by a separate substring lane). Single
 * characters are dropped. Two CJK words that touch each other also yield their
 * concatenation (up to 12 characters), so "書き" + "込み" can still find "書き込み".
 * Two-character hiragana-only words (particles, okurigana such as "する", "いる") are noise
 * for a substring match and are dropped before the short-term cap is applied.
 *
 * Known limitation: NFKC is applied to the query only, not to the indexed text, so a
 * query with compatibility characters can miss text stored in its un-normalized form.
 */
export function tokenizeQuery(query: string): {
	ftsTerms: string[];
	shortTerms: string[];
} {
	const text = query.normalize("NFKC").toLowerCase();
	const words: { word: string; start: number; end: number }[] = [];
	for (const segment of segmenter.segment(text)) {
		if (!segment.isWordLike) continue;
		words.push({
			word: segment.segment,
			start: segment.index,
			end: segment.index + segment.segment.length,
		});
	}

	const candidates: string[] = [];
	words.forEach((current, i) => {
		candidates.push(current.word);
		const next = words[i + 1];
		if (
			next &&
			next.start === current.end &&
			CJK_WORD.test(current.word) &&
			CJK_WORD.test(next.word) &&
			length(current.word) + length(next.word) <= MAX_JOINED_LENGTH
		) {
			candidates.push(current.word + next.word);
		}
	});

	const ftsTerms: string[] = [];
	const shortTerms: string[] = [];
	for (const term of new Set(candidates)) {
		const size = length(term);
		if (size >= 3) {
			if (ftsTerms.length < MAX_FTS_TERMS) ftsTerms.push(term);
		} else if (size === 2) {
			if (HIRAGANA_ONLY.test(term)) continue;
			if (shortTerms.length < MAX_SHORT_TERMS) shortTerms.push(term);
		}
	}
	return { ftsTerms, shortTerms };
}
