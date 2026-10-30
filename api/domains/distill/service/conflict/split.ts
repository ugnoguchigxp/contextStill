import { DistillError, type DistillDeps } from "../../contracts";
import {
	CONDITION_VERIFY_VERSION,
	conditionVerifyOutput,
	conditionVerifySystem,
	conditionVerifyUser,
} from "../../prompts/condition-split";
import type { JudgeSide } from "../../prompts/pair-judge";
import { callJson } from "../llm";

export type SplitVerdict = "supported" | "rejected" | "unknown";

/**
 * The verifier of a condition_split (6.5): are the conditions to add consistent with the
 * evidence of the canonical? An unusable answer is `unknown`; other failures are thrown.
 */
export async function verifyAddedConditions(
	deps: DistillDeps,
	args: {
		runId: string | null;
		subjectRef: string;
		item: JudgeSide;
		added: readonly string[];
		evidence: readonly { title: string; body: string }[];
		signal: AbortSignal;
	},
): Promise<SplitVerdict> {
	if (args.added.length === 0) return "supported";
	try {
		const { value } = await callJson(deps, {
			runId: args.runId,
			stage: "conflict",
			subjectRef: args.subjectRef,
			promptVersion: CONDITION_VERIFY_VERSION,
			system: conditionVerifySystem(),
			user: conditionVerifyUser({
				item: args.item,
				added: args.added,
				evidence: args.evidence,
			}),
			schema: conditionVerifyOutput,
			maxOutputTokens: 800,
			signal: args.signal,
		});
		return value.verdict;
	} catch (error) {
		if (error instanceof DistillError && error.code === "llm_invalid_output")
			return "unknown";
		throw error;
	}
}
