export interface QueryMetrics {
	recall: number;
	mrr: number;
	ndcg: number;
	firstRelevantRank: number | null;
}

/** One relevant claim: a hit on any of `keys` finds it, once; `grade` is the highest of its refs. */
export interface Claim {
	keys: readonly string[];
	grade: number;
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
	return claimMetrics(
		ranked,
		[...grades].map(([key, grade]) => ({ keys: [key], grade })),
		k,
	);
}

/**
 * Like `queryMetrics`, but a relevant item is a claim that several keys may stand for (the
 * atoms a canonical absorbed, or that canonical): only the first hit on a claim counts, at
 * the claim's grade. Recall is over claims. A key in two claims finds the first one not yet found.
 */
export function claimMetrics(
	ranked: readonly string[],
	claims: readonly Claim[],
	k: number,
): QueryMetrics {
	const top = [...new Set(ranked)].slice(0, k);
	const owners = new Map<string, number[]>();
	claims.forEach((claim, index) => {
		for (const key of claim.keys)
			owners.set(key, [...(owners.get(key) ?? []), index]);
	});
	const foundClaims = new Set<number>();
	let dcg = 0;
	let first: number | null = null;
	top.forEach((key, index) => {
		const claimIndex = owners.get(key)?.find((i) => !foundClaims.has(i));
		if (claimIndex === undefined) return;
		foundClaims.add(claimIndex);
		const rank = index + 1;
		first ??= rank;
		dcg += (2 ** claims[claimIndex]!.grade - 1) / Math.log2(rank + 1);
	});
	const ideal = claims
		.map((claim) => claim.grade)
		.sort((a, b) => b - a)
		.slice(0, k)
		.reduce(
			(sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2),
			0,
		);
	return {
		recall: claims.length === 0 ? 0 : foundClaims.size / claims.length,
		mrr: first === null ? 0 : 1 / first,
		ndcg: ideal === 0 ? 0 : dcg / ideal,
		firstRelevantRank: first,
	};
}
