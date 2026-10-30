/**
 * Multiply-adds between two yields of the event loop (the backend serves MCP in the meantime).
 * About 30 ms of work, so one chunk never holds the loop for long however many rows there are.
 */
export const YIELD_WORK = 30_000_000;

export interface Neighbor {
	index: number;
	similarity: number;
}

/**
 * The `k` nearest neighbours of every vector among those with a similarity of at least
 * `minSimilarity` (cosine of L2-normalised vectors, so a dot product), by brute force. Each
 * pair is computed once. Ties are broken by the lower index. The generator yields after
 * every `YIELD_WORK` multiply-adds (a few tens of ms) so a caller can let the event loop run; its return value is the
 * result.
 */
export function* nearestNeighbors(
	vectors: readonly Float32Array[],
	k: number,
	minSimilarity: number,
): Generator<void, Neighbor[][], void> {
	const n = vectors.length;
	const lists: Neighbor[][] = Array.from({ length: n }, () => []);
	const trim = (list: Neighbor[], keep: number) => {
		list.sort((a, b) => b.similarity - a.similarity || a.index - b.index);
		list.length = Math.min(list.length, keep);
	};
	let work = 0;
	for (let i = 0; i < n; i++) {
		const a = vectors[i]!;
		const dim = a.length;
		for (let j = i + 1; j < n; j++) {
			const b = vectors[j]!;
			let dot = 0;
			for (let d = 0; d < dim; d++) dot += a[d]! * b[d]!;
			if (dot < minSimilarity) continue;
			lists[i]!.push({ index: j, similarity: dot });
			lists[j]!.push({ index: i, similarity: dot });
			if (lists[j]!.length > 4 * k) trim(lists[j]!, k);
		}
		if (lists[i]!.length > 4 * k) trim(lists[i]!, k);
		work += (n - i - 1) * dim;
		if (work >= YIELD_WORK) {
			work = 0;
			yield;
		}
	}
	for (const list of lists) trim(list, k);
	return lists;
}

/** Runs a generator to its end without yielding to anyone. */
export function runSync<T>(gen: Generator<void, T, void>): T {
	for (;;) {
		const step = gen.next();
		if (step.done) return step.value;
	}
}

/** Runs a generator to its end, letting the event loop run at every yield. */
export async function runYielding<T>(
	gen: Generator<void, T, void>,
): Promise<T> {
	for (;;) {
		const step = gen.next();
		if (step.done) return step.value;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}
