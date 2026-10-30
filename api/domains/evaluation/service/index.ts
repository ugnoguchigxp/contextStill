import type { Database } from "bun:sqlite";
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
import { loadEvalSet } from "./load-set";
import { queryMetrics, type QueryMetrics } from "./metrics";

export { legacyQueryTokens, legacyScoreText } from "./legacy-score";
export { parseEvalSet } from "./load-set";
export { queryMetrics } from "./metrics";

const EPSILON = 1e-9;
const ALL_SYSTEMS: EvalSystem[] = [
	"legacy-lexical",
	"legacy-query-first",
	"v2-hybrid",
];
const STYLES: EvalStyle[] = ["paraphrase", "keyword", "question"];

interface ResolvedCase {
	evalCase: EvalCase;
	/** `kind:id` of each searchable relevant row, with its (highest) grade. */
	grades: Map<string, number>;
}

const keyOf = (kind: string, id: string) => `${kind}:${id}`;

interface RowFacts {
	status: string;
	scope: string;
	layer: string | null;
	space: string;
}

function rowFacts(
	db: Database,
	kind: "knowledge" | "episode",
	id: string,
): RowFacts | null {
	return kind === "knowledge"
		? db
				.query<RowFacts, [string]>(
					"SELECT status, scope, layer, space FROM knowledge_items WHERE id = ?",
				)
				.get(id)
		: db
				.query<RowFacts, [string]>(
					"SELECT status, scope, NULL AS layer, space FROM episodes WHERE id = ?",
				)
				.get(id);
}

/** The filter search applies for a case without a repoKey (same as `loadCandidates`). */
function isReachable(
	evalCase: EvalCase,
	kind: "knowledge" | "episode",
	facts: RowFacts | null,
): boolean {
	return (
		facts !== null &&
		evalCase.kinds.includes(kind) &&
		facts.status === "active" &&
		facts.scope === "global" &&
		(kind === "episode" || facts.layer === "atom") &&
		(evalCase.spaces as readonly string[]).includes(facts.space)
	);
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
			const grades = new Map<string, number>();
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
				if (!isReachable(evalCase, kind, rowFacts(db, kind, target.targetId))) {
					unreachable.add(ref);
					continue;
				}
				const key = keyOf(kind, target.targetId);
				grades.set(key, Math.max(grades.get(key) ?? 0, grade));
			}
			if (grades.size === 0) {
				deps.log(
					`eval: case ${evalCase.id} skipped (no searchable relevant ref)`,
				);
				continue;
			}
			out.push({ evalCase, grades });
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
});

function aggregate(perCase: readonly QueryMetrics[]): SystemMetrics {
	if (perCase.length === 0) return emptyMetrics();
	const mean = (pick: (m: QueryMetrics) => number) =>
		perCase.reduce((sum, m) => sum + pick(m), 0) / perCase.length;
	return {
		recallAtK: mean((m) => m.recall),
		mrrAtK: mean((m) => m.mrr),
		ndcgAtK: mean((m) => m.ndcg),
		queries: perCase.length,
		zeroHit: perCase.filter((m) => m.firstRelevantRank === null).length,
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
 * `unresolvedRefs`; those that resolve but that search can never return for the case in
 * `unreachableRefs`. Both are left out of the metrics, and a case with none left is skipped.
 * `wins` / `winsVsQueryFirst` compare v2-hybrid with a legacy baseline per case by nDCG@k
 * (only when both ran).
 */
export async function runEvaluation(
	deps: EvalDeps,
	args: EvalArgs,
): Promise<EvalReport> {
	if (!Number.isInteger(args.k) || args.k < 1 || args.k > 50)
		throw new Error("eval_invalid_k");
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
	};
	const collectedByStyle = new Map<string, QueryMetrics[]>();

	for (const { evalCase, grades } of resolved) {
		for (const system of systems) {
			let hits: Ranked[];
			if (system !== "v2-hybrid") {
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
				});
				hits = response.hits;
			}
			const metrics = queryMetrics(
				hits.map((hit) => keyOf(hit.kind, hit.id)),
				grades,
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
			perQuery.push({
				id: evalCase.id,
				system,
				hits: hits.slice(0, args.k).map((hit) => hit.handle),
				firstRelevantRank: metrics.firstRelevantRank,
			});
		}
	}

	const byStyle = {} as EvalReport["byStyle"];
	for (const style of STYLES) {
		byStyle[style] = {};
		for (const system of systems)
			if (collectedByStyle.has(`${style}|${system}`))
				byStyle[style][system] = aggregate(
					collectedByStyle.get(`${style}|${system}`) ?? [],
				);
	}

	const report: EvalReport = {
		set: basename(args.setPath).replace(/\.jsonl$/, ""),
		k: args.k,
		lanes: args.lanes,
		generatedAt: deps.now().toISOString(),
		systems: {
			"legacy-lexical": aggregate(collected["legacy-lexical"]),
			"legacy-query-first": aggregate(collected["legacy-query-first"]),
			"v2-hybrid": aggregate(collected["v2-hybrid"]),
		},
		unresolvedRefs: [...unresolved].sort(),
		unreachableRefs: [...unreachable].sort(),
		byStyle,
		perQuery,
		wins: tally(byCase, "legacy-lexical"),
		winsVsQueryFirst: tally(byCase, "legacy-query-first"),
	};
	writeReport(args.outPath, report);
	deps.log(
		`eval: ${resolved.length}/${cases.length} cases, ${unresolved.size} unresolved refs, ${unreachable.size} unreachable refs -> ${args.outPath}`,
	);
	return report;
}
