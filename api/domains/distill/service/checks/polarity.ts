import type { CanonicalDraft } from "../../contracts";
import type { Polarity } from "../../../knowledge";

export interface PolarityResult {
	ok: boolean;
	/** The majority polarity of the supports; `negative` on a tie. */
	majority: Polarity;
	/** The supports are split evenly: the group goes to the owner's review. */
	tie: boolean;
}

/** The draft's polarity must be the majority of its supports' (a tie prefers negative). */
export function checkPolarity(
	draft: Pick<CanonicalDraft, "polarity">,
	supports: readonly { polarity: Polarity }[],
): PolarityResult {
	const negative = supports.filter((s) => s.polarity === "negative").length;
	const positive = supports.length - negative;
	const tie = negative === positive;
	const majority: Polarity = negative >= positive ? "negative" : "positive";
	return { ok: draft.polarity === majority, majority, tie };
}
