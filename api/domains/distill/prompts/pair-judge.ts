/**
 * The pair judge of 6.5: for pairs of canonical items it decides whether they say the same thing
 * (duplicate), can both hold (compatible, condition_split) or cannot (conflict).
 * Bump `PAIR_JUDGE_VERSION` whenever the wording changes: the version is part of the call digest.
 */
export const PAIR_JUDGE_VERSION = "pair-judge-v1";
/** The audit's spot check judges again with a different wording (6.6 step 6). */
export const PAIR_RECHECK_VERSION = "pair-judge-recheck-v1";

export interface JudgeSide {
	situation: string;
	title: string;
	body: string;
	rationale: string;
	appliesWhen: string[];
	notAppliesWhen: string[];
	steps: string[];
	exceptions: string[];
}

const OUTPUT_FORMAT = `Answer with one JSON object and nothing else:
{"schemaVersion":1,"pairs":[{"index":0,"verdict":"duplicate|compatible|condition_split|conflict|unrelated|unknown","aNotAppliesWhen":[],"bNotAppliesWhen":[],"note":""}]}
- Give exactly one entry per pair, with the pair's index.
- "aNotAppliesWhen" and "bNotAppliesWhen" are non-empty only for "condition_split": at most 3 short conditions each, stating when A (respectively B) does NOT apply. Otherwise leave them [].
- "note" is one short sentence (at most 300 characters) naming the reason; do not copy long passages.`;

const RULES = `Verdicts:
- duplicate: A and B give the same guidance for the same situation. Wording, order or detail may differ, but nothing a reader would do differs.
- compatible: both can be followed at once; they cover different aspects or one refines the other without disagreeing.
- condition_split: they would disagree if applied to the same situation, but each is right under different conditions (the situations or conditions differ). State, for each, the condition under which it does NOT apply.
- conflict: in the same situation they tell the reader to do incompatible things, and no stated condition separates them.
- unrelated: they are about different things.
- unknown: you cannot tell from the text. Prefer "unknown" to a guess.
Judge only from the text shown. Do not use outside knowledge to resolve a disagreement. Numbers, units, negations and exceptions matter: a different number or an opposite polarity in the same situation is a disagreement.`;

export function pairJudgeSystem(version: string = PAIR_JUDGE_VERSION): string {
	const lead =
		version === PAIR_RECHECK_VERSION
			? "You audit a knowledge base. You are shown pairs of guidance items (A and B) and must classify how each pair relates."
			: "You compare pairs of guidance items (A and B) written for coding agents and classify how each pair relates.";
	return `${lead}\n\n${RULES}\n\n${OUTPUT_FORMAT}`;
}

function list(label: string, values: readonly string[]): string {
	return values.length === 0
		? ""
		: `${label}:\n${values.map((v) => `  - ${v}`).join("\n")}\n`;
}

function renderSide(name: "A" | "B", s: JudgeSide): string {
	return (
		`${name}:\n` +
		`  situation: ${s.situation}\n` +
		`  title: ${s.title}\n` +
		`  guidance: ${s.body}\n` +
		(s.rationale ? `  rationale: ${s.rationale}\n` : "") +
		list("  applies when", s.appliesWhen) +
		list("  does not apply when", s.notAppliesWhen) +
		list("  steps", s.steps) +
		list("  exceptions", s.exceptions)
	);
}

export function pairJudgeUser(
	pairs: readonly { a: JudgeSide; b: JudgeSide }[],
): string {
	return pairs
		.map(
			(p, index) =>
				`### Pair ${index}\n${renderSide("A", p.a)}${renderSide("B", p.b)}`,
		)
		.join("\n");
}
