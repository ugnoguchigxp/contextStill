export interface QueryMetrics {
	recall: number;
	mrr: number;
	ndcg: number;
	firstRelevantRank: number | null;
}

/**
 * `ranked` are the result keys in rank order (best first, at most k are used);
 * `grades` maps each relevant key to its grade (1..3).
 */
export function queryMetrics(
	ranked: readonly string[],
	grades: ReadonlyMap<string, number>,
	k: number,
): QueryMetrics {
	const top = [...new Set(ranked)].slice(0, k);
	let found = 0;
	let dcg = 0;
	let first: number | null = null;
	top.forEach((key, index) => {
		const grade = grades.get(key);
		if (grade === undefined) return;
		const rank = index + 1;
		found += 1;
		first ??= rank;
		dcg += (2 ** grade - 1) / Math.log2(rank + 1);
	});
	const ideal = [...grades.values()]
		.sort((a, b) => b - a)
		.slice(0, k)
		.reduce(
			(sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2),
			0,
		);
	return {
		recall: grades.size === 0 ? 0 : found / grades.size,
		mrr: first === null ? 0 : 1 / first,
		ndcg: ideal === 0 ? 0 : dcg / ideal,
		firstRelevantRank: first,
	};
}
