export const NOVELTY_MIN_RATIO = 0.6;

export interface NoveltyResult {
	ok: boolean;
	/** Share of the claim's content words found in the supporting texts (1 when it has none). */
	ratio: number;
	contentWords: number;
	/** Numbers with units, identifiers and code spans of the claim that no supporting text has. */
	unsupportedLiterals: string[];
}

const STOP_WORDS: ReadonlySet<string> = new Set([
	// English
	"the",
	"and",
	"for",
	"are",
	"was",
	"were",
	"with",
	"that",
	"this",
	"these",
	"those",
	"from",
	"into",
	"when",
	"then",
	"than",
	"not",
	"but",
	"can",
	"should",
	"must",
	"will",
	"would",
	"could",
	"may",
	"might",
	"have",
	"has",
	"had",
	"been",
	"being",
	"its",
	"their",
	"them",
	"they",
	"you",
	"your",
	"our",
	"any",
	"all",
	"each",
	"also",
	"only",
	"such",
	"which",
	"while",
	"where",
	"what",
	"who",
	"how",
	"use",
	"used",
	"using",
	"does",
	"did",
	// Japanese function words and light verbs
	"する",
	"した",
	"して",
	"している",
	"します",
	"される",
	"された",
	"され",
	"できる",
	"できない",
	"ある",
	"あり",
	"ない",
	"なく",
	"こと",
	"もの",
	"ため",
	"よう",
	"これ",
	"それ",
	"また",
	"など",
	"および",
	"ただし",
	"場合",
	"とき",
	"れる",
	"から",
	"まで",
	"より",
	"ので",
	"です",
	"ます",
	"でき",
	"いる",
	"なる",
	"なり",
	"という",
	"として",
]);

const SEGMENTER = new Intl.Segmenter("ja", { granularity: "word" });

const norm = (s: string) => s.normalize("NFKC").toLowerCase();
const squash = (s: string) => norm(s).replace(/\s+/g, "");

/** Words of two or more characters that are not stop words and not numbers. */
export function contentWords(text: string): string[] {
	const words = new Set<string>();
	for (const part of SEGMENTER.segment(norm(text))) {
		if (!part.isWordLike) continue;
		const word = part.segment.trim();
		if ([...word].length < 2 || STOP_WORDS.has(word) || /^[\d.,]+$/.test(word))
			continue;
		words.add(word);
	}
	return [...words];
}

const CODE_SPAN = /`([^`\n]+)`/g;
// A number, with its unit when it has one from this list (a bare number is a literal too).
const UNIT =
	"%|ms|sec(?:ond)?s?|min(?:ute)?s?|h|hrs?|hours?|days?|weeks?|[kmgt]i?b|bytes?|px|rem|em|x|times|retries|attempts|files|items|rows|lines|chars|characters|[秒分時間日件回個倍円万千行文字]{1,2}";
const VALUE = new RegExp(
	`\\d+(?:[.,]\\d+)*(?:\\s?(?:${UNIT})(?![A-Za-z]))?`,
	"gi",
);
const IDENT = /[A-Za-z_][A-Za-z0-9_]*(?:[-.][A-Za-z0-9_]+)*/g;

function looksLikeIdentifier(token: string): boolean {
	if (/\d|_/.test(token)) return true;
	if (token.includes(".")) return token.split(".").every((p) => p.length >= 2);
	// camelCase or a PascalCase word with two humps
	return /[a-z][A-Z]/.test(token) || /^[A-Z][a-z]+[A-Z]/.test(token);
}

/** Literals that must be copied from a supporting text: values with units, identifiers, code. */
export function literalsOf(claim: string): string[] {
	const text = claim.normalize("NFKC");
	const out = new Set<string>();
	for (const m of text.matchAll(CODE_SPAN)) out.add(m[1]!.trim());
	const withoutCode = text.replace(CODE_SPAN, " ");
	for (const m of withoutCode.matchAll(VALUE)) out.add(m[0].trim());
	for (const m of withoutCode.matchAll(IDENT))
		if (looksLikeIdentifier(m[0])) out.add(m[0]);
	return [...out].filter((l) => l !== "");
}

/**
 * "No new claim" (6.4): at least 60% of the claim's content words occur in the supporting
 * texts, and every literal of the claim occurs verbatim (case-insensitive, spaces ignored) in one
 * of them.
 */
export function checkNovelty(
	claim: string,
	supportTexts: readonly string[],
): NoveltyResult {
	const haystack = norm(supportTexts.join("\n"));
	const squashed = squash(supportTexts.join("\n"));
	const words = contentWords(claim);
	const found = words.filter((w) => haystack.includes(w)).length;
	const ratio = words.length === 0 ? 1 : found / words.length;
	const unsupportedLiterals = literalsOf(claim).filter(
		(l) => !squashed.includes(squash(l)),
	);
	return {
		ok: ratio >= NOVELTY_MIN_RATIO && unsupportedLiterals.length === 0,
		ratio,
		contentWords: words.length,
		unsupportedLiterals,
	};
}

// ---- negation ---------------------------------------------------------------------------
// "not" and its Japanese counterparts are stop words, so the word ratio cannot see a flipped
// meaning ("do not skip" -> "skip"). This compares the negation of a claim with the supporting
// sentence it is drawn from.

// "never skip", "しないことを省略しない": a negated word that means the opposite of leaving out.
const CANCELLED_NEGATION =
	/\b(?:never|not|no)\s+(?:to\s+)?(?:skip|omit|forget|neglect|ignore|bypass|fail\s+to)\b|\b(?:don't|doesn't|do not|does not|cannot|can't|must not|mustn't|should not|shouldn't)\s+(?:skip|omit|forget|neglect|ignore|bypass|fail\s+to)\b|省略しない|省かない|忘れない|スキップしない|怠らない|欠かさない|欠かせない|無視しない/g;
const NEGATION_EN =
	/\b(?:not|no|never|cannot|neither|nor|none|nothing|without|avoid|avoids|avoiding|\w+n't)\b/;
const NEGATION_JA =
	/ない|なく|なかっ|ません|せず|ずに|禁止|不要|不可|避け|してはならな|べからず|なし(?!と)/;

const unify = (s: string) => norm(s).replace(/[’‘`´]/g, "'");

/** True when the sentence says no/not/never (a cancelled negation such as "never skip" does not count). */
export function hasNegation(sentence: string): boolean {
	const text = unify(sentence).replace(CANCELLED_NEGATION, " ");
	return NEGATION_EN.test(text) || NEGATION_JA.test(text);
}

const SENTENCE_BREAK = /[。！？!?\n;；]+|\.(?=\s|$)/;
const MIN_OVERLAP = 0.7;

export interface NegationResult {
	ok: boolean;
	/** The claim says no/not/never. */
	claimNegated: boolean;
	/** Negation of the supporting sentence(s) closest to the claim (null when none is close). */
	supportNegated: boolean | null;
}

/**
 * The negation of `claim` must be the negation of the supporting sentence it is drawn from: the
 * sentence(s) sharing the most content words with it, when they cover at least 70% of the
 * claim's words. A claim that spans several sentences, or has no close sentence, is not judged
 * here (the word ratio and the verifier remain).
 */
export function checkNegation(
	claim: string,
	supportTexts: readonly string[],
): NegationResult {
	const claimNegated = hasNegation(claim);
	const words = contentWords(claim);
	if (words.length < 2) return { ok: true, claimNegated, supportNegated: null };
	let best = 0;
	let selected: string[] = [];
	for (const text of supportTexts)
		for (const raw of text.split(SENTENCE_BREAK)) {
			const sentence = raw.trim();
			if (sentence === "") continue;
			const hay = norm(sentence);
			const overlap = words.filter((w) => hay.includes(w)).length;
			if (overlap > best) {
				best = overlap;
				selected = [sentence];
			} else if (overlap === best && overlap > 0) selected.push(sentence);
		}
	if (best / words.length < MIN_OVERLAP)
		return { ok: true, claimNegated, supportNegated: null };
	const negated = selected.map(hasNegation);
	// Any closest sentence with the same negation is enough.
	if (negated.includes(claimNegated))
		return { ok: true, claimNegated, supportNegated: claimNegated };
	return { ok: false, claimNegated, supportNegated: !claimNegated };
}
