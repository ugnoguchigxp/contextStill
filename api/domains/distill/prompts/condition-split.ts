import { z } from "zod";
import { type JudgeSide } from "./pair-judge";

/**
 * 6.5 condition_split: the judge names, for each canonical, conditions under which it does not
 * apply. They are added to `notAppliesWhen` only after this verifier agrees they do not
 * contradict the evidence. Bump the versions when the wording changes (they are part of the
 * call digest).
 */
export const CONDITION_VERIFY_VERSION = "condition-verify-v1";
/** The owner chose "split" for a pair the judge did not split: ask the judge for conditions. */
export const SPLIT_PROPOSE_VERSION = "pair-split-v1";

export const conditionVerifyOutput = z.strictObject({
	schemaVersion: z.literal(1),
	verdict: z.enum(["supported", "rejected", "unknown"]),
	rationale: z.string().max(400),
});
export type ConditionVerifyOutput = z.infer<typeof conditionVerifyOutput>;

export function conditionVerifySystem(): string {
	return `You check a proposed edit to a guidance item. The edit adds "does not apply when" conditions; the item itself is unchanged.
You are shown the item, the conditions to add, and the evidence the item was distilled from.
Answer "supported" only if every added condition is consistent with the evidence: the evidence never says the item applies under that condition, and the conditions do not remove the situation the item is about.
Answer "rejected" if some added condition contradicts the evidence or empties the item's situation. Answer "unknown" if the evidence does not let you decide.
Judge only from the text shown.
Answer with one JSON object and nothing else:
{"schemaVersion":1,"verdict":"supported|rejected|unknown","rationale":"one or two short sentences"}`;
}

export function conditionVerifyUser(input: {
	item: JudgeSide;
	added: readonly string[];
	evidence: readonly { title: string; body: string }[];
}): string {
	const item = input.item;
	const lines = [
		"ITEM",
		`situation: ${item.situation}`,
		`title: ${item.title}`,
		`guidance: ${item.body}`,
		...(item.notAppliesWhen.length
			? [
					"already does not apply when:",
					...item.notAppliesWhen.map((c) => `  - ${c}`),
				]
			: []),
		"",
		"CONDITIONS TO ADD (does not apply when)",
		...input.added.map((c, i) => `  ${i + 1}. ${c}`),
		"",
		"EVIDENCE",
		...input.evidence.map((e, i) => `[${i + 1}] ${e.title}\n${e.body}`),
	];
	return lines.join("\n");
}

export function splitProposeSystem(): string {
	return `You are shown one pair of guidance items (A and B) that an owner wants to keep both, each limited to its own situation.
Say, for each, under which conditions it does NOT apply so that the two no longer collide. Use short, concrete conditions (at most 3 each) that follow from the two texts; do not invent facts.
If the texts give no basis for such conditions, answer "unknown".
Answer with one JSON object and nothing else:
{"schemaVersion":1,"pairs":[{"index":0,"verdict":"condition_split|unknown","aNotAppliesWhen":[],"bNotAppliesWhen":[],"note":"one short sentence"}]}`;
}
