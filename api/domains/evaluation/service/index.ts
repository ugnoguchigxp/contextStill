import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import type {
	EvalArgs,
	EvalCase,
	EvalDeps,
	EvalReport,
	EvalStyle,
	EvalSystem,
	SystemMetrics,
} from "../contracts";
import { resolveLegacyRef } from "../../legacy";
import {
	loadCandidates,
	rankLegacy,
	type Candidate,
	type Ranked,
} from "./legacy-lexical";
import {
	dupConflictRates,
	type DupConflict,
	type JudgePairs,
	type RankedHit,
} from "./duplicates";
import { loadEvalSet } from "./load-set";
import { claimMetrics, type Claim, type QueryMetrics } from "./metrics";
import { keyOf, resolveTargets } from "./resolve";

export { legacyQueryTokens, legacyScoreText } from "./legacy-score";
export { parseEvalSet } from "./load-set";
export { queryMetrics } from "./metrics";

const EPSILON = 1e-9;
const ALL_SYSTEMS: EvalSystem[] = [
	"legacy-lexical",
	"legacy-query-first",
	"v2-hybrid",
	"v2-atom-baseline",
];
const STYLES: EvalStyle[] = ["paraphrase", "keyword", "question", "scenario"];

export interface EvalOptions {
	/** `DistillService.judgePairs`; required when `args.judge` is true */
	judgePairs?: JudgePairs;
}

interface ResolvedCase {
	evalCase: EvalCase;
	/**
	 * Relevant claims of what `v2-hybrid` can return now (supersedes followed): the refs that
	 * reach the same canonical form one claim.
	 */
	claims: Claim[];
	/**
	 * The same claims on the atoms before distillation (baseline and legacy systems): a hit on
	 * any atom of a claim finds it, once, at the claim's highest grade. A claim no atom
	 * stands for (a canonical ref) is not in this list.
	 */
	baselineClaims: Claim[];
}

interface RefClaim {
	current: string[];
	baseline: string[];
	grade: number;
}

/**
 * Folds the refs of a case into claims: refs whose current targets share a key (several
 * atoms absorbed into one canonical, or one atom absorbed into several) are one claim, with
 * the highest grade. Both the current and the baseline sides count these same claims, so
 * recall and nDCG compare on one population.
 */
function foldClaims(refs: readonly RefClaim[]): {
	claims: Claim[];
	baselineClaims: Claim[];
} {
	const parent = new Map<string, string>();
	const find = (key: string): string => {
		let root = key;
		let up = parent.get(root);
		while (up !== undefined && up !== root) {
			root = up;
			up = parent.get(root);
		}
		parent.set(key, root);
		return root;
	};
	for (const ref of refs) {
		for (const key of ref.current) if (!parent.has(key)) parent.set(key, key);
		const [head, ...rest] = ref.current;
		for (const key of rest) parent.set(find(key), find(head!));
	}
	const groups = new Map<
		string,
		{ current: Set<string>; baseline: Set<string>; grade: number }
	>();
	for (const ref of refs) {
		const root = find(ref.current[0]!);
		const group = groups.get(root) ?? {
			current: new Set<string>(),
			baseline: new Set<string>(),
			grade: 0,
		};
		for (const key of ref.current) group.current.add(key);
		for (const key of ref.baseline) group.baseline.add(key);
		group.grade = Math.max(group.grade, ref.grade);
		groups.set(root, group);
	}
	const claims: Claim[] = [];
	const baselineClaims: Claim[] = [];
	for (const group of groups.values()) {
		claims.push({ keys: [...group.current], grade: group.grade });
		if (group.baseline.size > 0)
			baselineClaims.push({ keys: [...group.baseline], grade: group.grade });
	}
	return { claims, baselineClaims };
}

function resolveCases(
	deps: EvalDeps,
	cases: readonly EvalCase[],
	unresolved: Set<string>,
	unreachable: Set<string>,
): ResolvedCase[] {
	return deps.store.read((db) => {
		const out: ResolvedCase[] = [];
		for (const evalCase of cases) {
			const refs: RefClaim[] = [];
			for (const { ref, grade } of evalCase.relevant) {
				const target = resolveLegacyRef(db, ref);
				const kind =
					target?.targetTable === "knowledge_items"
						? "knowledge"
						: target?.targetTable === "episodes"
							? "episode"
							: null;
				if (!target || !kind) {
					unresolved.add(ref);
					continue;
				}
				const targets = resolveTargets(db, evalCase, kind, target.targetId);
				if (!targets) {
					unreachable.add(ref);
					continue;
				}
				refs.push({ ...targets, grade });
			}
			if (refs.length === 0) {
				deps.log(
					`eval: case ${evalCase.id} skipped (no searchable relevant ref)`,
				);
				continue;
			}
			out.push({ evalCase, ...foldClaims(refs) });
		}
		return out;
	});
}

const emptyMetrics = (): SystemMetrics => ({
	recallAtK: 0,
	mrrAtK: 0,
	ndcgAtK: 0,
	queries: 0,
	zeroHit: 0,
	dupRateAtK: null,
	conflictRateAtK: null,
});

function aggregate(
	perCase: readonly QueryMetrics[],
	dup: DupConflict | undefined,
): SystemMetrics {
	if (perCase.length === 0) return emptyMetrics();
	const mean = (pick: (m: QueryMetrics) => number) =>
		perCase.reduce((sum, m) => sum + pick(m), 0) / perCase.length;
	return {
		recallAtK: mean((m) => m.recall),
		mrrAtK: mean((m) => m.mrr),
		ndcgAtK: mean((m) => m.ndcg),
		queries: perCase.length,
		zeroHit: perCase.filter((m) => m.firstRelevantRank === null).length,
		dupRateAtK: dup?.dupRate ?? null,
		conflictRateAtK: dup?.conflictRate ?? null,
	};
}

function writeReport(path: string, report: EvalReport) {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(report, null, 2)}\n`);
	renameSync(tmp, path);
}

function tally(
	byCase: Map<string, Partial<Record<EvalSystem, QueryMetrics>>>,
	baseline: EvalSystem,
) {
	const wins = { v2: 0, legacy: 0, tie: 0 };
	for (const metrics of byCase.values()) {
		const v2 = metrics["v2-hybrid"];
		const legacy = metrics[baseline];
		if (!v2 || !legacy) continue;
		const diff = v2.ndcg - legacy.ndcg;
		if (diff > EPSILON) wins.v2 += 1;
		else if (diff < -EPSILON) wins.legacy += 1;
		else wins.tie += 1;
	}
	return wins;
}

/**
 * Runs `args.systems` over the set. Relevant refs that do not resolve are listed in
 * `unresolvedRefs`; those that resolve but that search can never return for the case (nor a
 * canonical that replaced them through `supersedes`) in `unreachableRefs`. Both are left out
 * of the metrics, and a case with none left is skipped.
 *
 * `v2-hybrid` is graded on what search returns now: a superseded atom stands for the active
 * canonical that replaced it. Refs that reach the same canonical are one claim (the highest
 * grade), and recall and nDCG count claims. `v2-atom-baseline` and the legacy systems are
 * graded on the atoms themselves, over the pool before distillation, on the same claims: a
 * hit on any atom of a claim finds it once, so both sides share one population.
 *
 * `dupRateAtK` judges "the same claim" by the `supersedes` edges, so it is structurally 0 for
 * `v2-atom-baseline` while no edge exists. Measure the baseline's dupRate after re-distillation
 * (the log line says so when that system ran).
 *
 * `dupRateAtK` / `conflictRateAtK` need a verdict for every pair of canonicals in the top k;
 * with `args.judge` the missing ones go to `options.judgePairs`, without it a system that
 * has such a pair reports null. `wins` / `winsVsQueryFirst` compare v2-hybrid with a legacy
 * baseline per case by nDCG@k (only when both ran).
 */
export async function runEvaluation(
	deps: EvalDeps,
	args: EvalArgs,
	options: EvalOptions = {},
): Promise<EvalReport> {
	if (!Number.isInteger(args.k) || args.k < 1 || args.k > 50)
		throw new Error("eval_invalid_k");
	if (args.judge && !options.judgePairs)
		throw new Error("eval_judge_unavailable");
	const systems = ALL_SYSTEMS.filter((system) => args.systems.includes(system));
	const cases = loadEvalSet(args.setPath);
	const unresolved = new Set<string>();
	const unreachable = new Set<string>();
	const resolved = resolveCases(deps, cases, unresolved, unreachable);

	const candidateCache = new Map<string, Candidate[]>();
	const candidatesFor = (evalCase: EvalCase) => {
		const key = JSON.stringify([evalCase.spaces, evalCase.kinds]);
		let found = candidateCache.get(key);
		if (!found) {
			found = deps.store.read((db) =>
				loadCandidates(db, evalCase.spaces, evalCase.kinds),
			);
			candidateCache.set(key, found);
		}
		return found;
	};

	const perQuery: EvalReport["perQuery"] = [];
	const byCase = new Map<string, Partial<Record<EvalSystem, QueryMetrics>>>();
	const collected: Record<EvalSystem, QueryMetrics[]> = {
		"legacy-lexical": [],
		"legacy-query-first": [],
		"v2-hybrid": [],
		"v2-atom-baseline": [],
	};
	const collectedByStyle = new Map<string, QueryMetrics[]>();
	// top-k lists per system and per "style|system", for the duplicate and conflict rates
	const listsBy = new Map<string, RankedHit[][]>();
	const pushList = (key: string, hits: RankedHit[]) =>
		listsBy.set(key, [...(listsBy.get(key) ?? []), hits]);

	for (const { evalCase, claims, baselineClaims } of resolved) {
		for (const system of systems) {
			let hits: Ranked[];
			if (system === "legacy-lexical" || system === "legacy-query-first") {
				hits = rankLegacy(
					candidatesFor(evalCase),
					evalCase.query,
					args.k,
					system === "legacy-query-first" ? "query-first" : "lexical",
				);
			} else {
				const response = await deps.search.search({
					query: evalCase.query,
					kinds: evalCase.kinds,
					spaces: evalCase.spaces,
					lanes: args.lanes,
					limit: args.k,
					...(system === "v2-atom-baseline"
						? { layers: ["atom"], includeSuperseded: true }
						: {}),
				});
				hits = response.hits;
			}
			const metrics = claimMetrics(
				hits.map((hit) => keyOf(hit.kind, hit.id)),
				system === "v2-hybrid" ? claims : baselineClaims,
				args.k,
			);
			collected[system].push(metrics);
			const styleKey = `${evalCase.style}|${system}`;
			collectedByStyle.set(styleKey, [
				...(collectedByStyle.get(styleKey) ?? []),
				metrics,
			]);
			byCase.set(evalCase.id, {
				...byCase.get(evalCase.id),
				[system]: metrics,
			});
			const top = hits
				.slice(0, args.k)
				.map((hit) => ({ kind: hit.kind, id: hit.id }));
			pushList(system, top);
			pushList(styleKey, top);
			perQuery.push({
				id: evalCase.id,
				system,
				hits: hits.slice(0, args.k).map((hit) => hit.handle),
				firstRelevantRank: metrics.firstRelevantRank,
			});
		}
	}

	const { rates, judged } = await dupConflictRates(
		deps.store,
		listsBy,
		args.judge ? (options.judgePairs ?? null) : null,
	);

	const byStyle = {} as EvalReport["byStyle"];
	for (const style of STYLES) {
		byStyle[style] = {};
		for (const system of systems)
			if (collectedByStyle.has(`${style}|${system}`))
				byStyle[style][system] = aggregate(
					collectedByStyle.get(`${style}|${system}`) ?? [],
					rates.get(`${style}|${system}`),
				);
	}

	const report: EvalReport = {
		set: basename(args.setPath).replace(/\.jsonl$/, ""),
		k: args.k,
		lanes: args.lanes,
		generatedAt: deps.now().toISOString(),
		systems: {
			"legacy-lexical": aggregate(
				collected["legacy-lexical"],
				rates.get("legacy-lexical"),
			),
			"legacy-query-first": aggregate(
				collected["legacy-query-first"],
				rates.get("legacy-query-first"),
			),
			"v2-hybrid": aggregate(collected["v2-hybrid"], rates.get("v2-hybrid")),
			"v2-atom-baseline": aggregate(
				collected["v2-atom-baseline"],
				rates.get("v2-atom-baseline"),
			),
		},
		unresolvedRefs: [...unresolved].sort(),
		unreachableRefs: [...unreachable].sort(),
		byStyle,
		perQuery,
		wins: tally(byCase, "legacy-lexical"),
		winsVsQueryFirst: tally(byCase, "legacy-query-first"),
	};
	writeReport(args.outPath, report);
	if (systems.includes("v2-atom-baseline"))
		deps.log(
			"eval: v2-atom-baseline dupRate@k follows supersedes edges and is 0 before re-distillation; measure it after",
		);
	deps.log(
		`eval: ${resolved.length}/${cases.length} cases, ${unresolved.size} unresolved refs, ${unreachable.size} unreachable refs${args.judge ? `, ${judged} pairs judged` : ""} -> ${args.outPath}`,
	);
	return report;
}
