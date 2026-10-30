import type { KnowledgeRow } from "../../../knowledge";
import {
	DistillError,
	pairOutput,
	type DistillDeps,
	type PairVerdict,
} from "../../contracts";
import {
	PAIR_JUDGE_VERSION,
	pairJudgeSystem,
	pairJudgeUser,
	type JudgeSide,
} from "../../prompts/pair-judge";
import { callJson } from "../llm";

export const PAIR_BATCH = 8;

export function judgeSide(row: KnowledgeRow): JudgeSide {
	return {
		situation: row.situation,
		title: row.title,
		body: row.body,
		rationale: row.rationale,
		appliesWhen: row.appliesWhen,
		notAppliesWhen: row.notAppliesWhen,
		steps: row.steps,
		exceptions: row.exceptions,
	};
}

export interface JudgeItem {
	a: string;
	b: string;
	aSide: JudgeSide;
	bSide: JudgeSide;
}

export interface JudgedBatch {
	verdicts: PairVerdict[];
	/** The distill_llm_calls row, null when the model's answer was unusable. */
	callId: string | null;
	/** true when the model's output stayed invalid after the one repair round. */
	invalid: boolean;
}

const clean = (values: readonly string[]): string[] => {
	const out: string[] = [];
	for (const v of values) {
		const t = v.trim();
		if (t !== "" && !out.includes(t)) out.push(t);
	}
	return out;
};

/**
 * The host rules over the model's answer: every pair gets exactly one verdict (a missing or
 * repeated index is `unknown`); conditions are kept only for `condition_split`, and a
 * `condition_split` without any condition is `unknown`.
 */
export function normalizeVerdicts(
	items: readonly Pick<JudgeItem, "a" | "b">[],
	output: ReturnType<typeof pairOutput.parse> | null,
): PairVerdict[] {
	const byIndex = new Map<number, PairVerdict | "duplicate">();
	for (const p of output?.pairs ?? []) {
		if (p.index >= items.length) continue;
		if (byIndex.has(p.index)) {
			byIndex.set(p.index, "duplicate");
			continue;
		}
		const item = items[p.index]!;
		let verdict: PairVerdict["verdict"] = p.verdict;
		let aNot = clean(p.aNotAppliesWhen);
		let bNot = clean(p.bNotAppliesWhen);
		if (verdict === "condition_split") {
			if (aNot.length === 0 && bNot.length === 0) verdict = "unknown";
		} else {
			aNot = [];
			bNot = [];
		}
		byIndex.set(p.index, {
			a: item.a,
			b: item.b,
			verdict,
			aNotAppliesWhen: aNot,
			bNotAppliesWhen: bNot,
			note: p.note,
		});
	}
	return items.map((item, index) => {
		const v = byIndex.get(index);
		return v && v !== "duplicate"
			? v
			: {
					a: item.a,
					b: item.b,
					verdict: "unknown" as const,
					aNotAppliesWhen: [],
					bNotAppliesWhen: [],
					note: "",
				};
	});
}

/**
 * One model call for up to 8 pairs. An unusable answer (`llm_invalid_output`) is returned as
 * `invalid` with every pair `unknown`; any other failure, `LarmError` included, is thrown.
 */
export async function judgeBatch(
	deps: DistillDeps,
	args: {
		runId: string | null;
		items: readonly JudgeItem[];
		signal: AbortSignal;
		promptVersion?: string;
		subjectRef: string;
	},
): Promise<JudgedBatch> {
	if (args.items.length === 0)
		return { verdicts: [], callId: null, invalid: false };
	if (args.items.length > PAIR_BATCH)
		throw new DistillError("invalid_distill_request");
	const version = args.promptVersion ?? PAIR_JUDGE_VERSION;
	try {
		const { value, callId } = await callJson(deps, {
			runId: args.runId,
			stage: "conflict",
			subjectRef: args.subjectRef,
			promptVersion: version,
			system: pairJudgeSystem(version),
			user: pairJudgeUser(args.items.map((i) => ({ a: i.aSide, b: i.bSide }))),
			schema: pairOutput,
			maxOutputTokens: 2000,
			signal: args.signal,
		});
		return {
			verdicts: normalizeVerdicts(args.items, value),
			callId,
			invalid: false,
		};
	} catch (error) {
		if (error instanceof DistillError && error.code === "llm_invalid_output")
			return {
				verdicts: normalizeVerdicts(args.items, null),
				callId: null,
				invalid: true,
			};
		throw error;
	}
}
