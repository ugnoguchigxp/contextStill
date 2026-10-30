import { sha256Hex } from "../../../../infrastructure/digest";
import { getKnowledgeById } from "../../../knowledge";
import type { DistillDeps } from "../../contracts";
import { PAIR_RECHECK_VERSION } from "../../prompts/pair-judge";
import { getPairJudgment } from "../../repository";
import { scanCandidatesYielding } from "../conflict/candidates";
import {
	PAIR_BATCH,
	judgeBatch,
	judgeSide,
	type JudgeItem,
} from "../conflict/judge";

export interface ResampleReport {
	sampled: number;
	/** Pairs the first judgment called conflict. */
	conflictBefore: number;
	/** Of those, the pairs the second judgment also called conflict. */
	conflictAgreed: number;
	/** conflictAgreed / conflictBefore; null when there was no conflict in the sample. */
	conflictAgreement: number | null;
}

/**
 * The spot check of 6.6 step 6, not part of the audit's counts: 100 candidate pairs chosen by a
 * fixed order (the digest of the pair), judged again with another prompt version, and the
 * agreement on `conflict` reported. Uses the model, so it is a separate call from `audit()`.
 */
export async function resampleJudgments(
	deps: DistillDeps,
	opts: { n?: number; signal?: AbortSignal } = {},
): Promise<ResampleReport> {
	const n = opts.n ?? 100;
	const signal = opts.signal ?? new AbortController().signal;
	const scan = await scanCandidatesYielding(deps.store, deps.spaceKey);
	const ordered = scan.pairs
		.map((p) => ({
			p,
			key: sha256Hex(`${p.a}|${p.b}|${p.aDigest}|${p.bDigest}`),
		}))
		.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0))
		.slice(0, n);
	const chosen = deps.store.read((db) =>
		ordered.flatMap(({ p }) => {
			const j = getPairJudgment(db, p.a, p.b);
			const x = getKnowledgeById(db, p.a);
			const y = getKnowledgeById(db, p.b);
			if (!j || !x || !y) return [];
			const item: JudgeItem = {
				a: p.a,
				b: p.b,
				aSide: judgeSide(x),
				bSide: judgeSide(y),
			};
			return [{ item, before: j.verdict }];
		}),
	);
	let before = 0;
	let agreed = 0;
	for (let i = 0; i < chosen.length; i += PAIR_BATCH) {
		const batch = chosen.slice(i, i + PAIR_BATCH);
		const judged = await judgeBatch(deps, {
			runId: null,
			items: batch.map((c) => c.item),
			signal,
			promptVersion: PAIR_RECHECK_VERSION,
			subjectRef: "audit-resample",
		});
		batch.forEach((c, k) => {
			if (c.before !== "conflict") return;
			before++;
			if (judged.verdicts[k]?.verdict === "conflict") agreed++;
		});
	}
	return {
		sampled: chosen.length,
		conflictBefore: before,
		conflictAgreed: agreed,
		conflictAgreement: before === 0 ? null : agreed / before,
	};
}
