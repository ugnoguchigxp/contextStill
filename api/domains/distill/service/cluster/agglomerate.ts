/** A similarity is compared at this resolution so float noise cannot decide a tie. */
const RESOLUTION = 1e9;
export const quantize = (x: number): number =>
	Math.round(x * RESOLUTION) / RESOLUTION;

export interface AgglomerateInput {
	/** L2-normalised vectors. */
	vectors: readonly Float32Array[];
	/** Tie-break key of each vector (the knowledge `seq`). */
	seqs: readonly number[];
	/** Candidate edges between vector indices (the neighbours at or above `clusterEdge`). */
	edges: readonly (readonly [number, number])[];
	/** Lower bound of the average link. */
	merge: number;
	/** Largest cluster. */
	cap: number;
}

interface Cluster {
	id: number;
	alive: boolean;
	members: number[];
	/** Sum of the member vectors: sum over pairs of cosines = dot of two sums. */
	sum: Float64Array;
	minSeq: number;
	neighbors: Set<number>;
}

interface Candidate {
	avg: number;
	lowSeq: number;
	highSeq: number;
	a: number;
	b: number;
}

/** Best first: higher average link, then the lower minimum seqs, then the lower ids. */
function before(x: Candidate, y: Candidate): boolean {
	if (x.avg !== y.avg) return x.avg > y.avg;
	if (x.lowSeq !== y.lowSeq) return x.lowSeq < y.lowSeq;
	if (x.highSeq !== y.highSeq) return x.highSeq < y.highSeq;
	if (x.a !== y.a) return x.a < y.a;
	return x.b < y.b;
}

class Heap {
	private items: Candidate[] = [];
	get size(): number {
		return this.items.length;
	}
	push(item: Candidate): void {
		const a = this.items;
		a.push(item);
		let i = a.length - 1;
		while (i > 0) {
			const parent = (i - 1) >> 1;
			if (!before(a[i]!, a[parent]!)) break;
			[a[i], a[parent]] = [a[parent]!, a[i]!];
			i = parent;
		}
	}
	pop(): Candidate | undefined {
		const a = this.items;
		const top = a[0];
		const last = a.pop();
		if (a.length > 0 && last) {
			a[0] = last;
			let i = 0;
			for (;;) {
				const l = 2 * i + 1;
				const r = l + 1;
				let best = i;
				if (l < a.length && before(a[l]!, a[best]!)) best = l;
				if (r < a.length && before(a[r]!, a[best]!)) best = r;
				if (best === i) break;
				[a[i], a[best]] = [a[best]!, a[i]!];
				i = best;
			}
		}
		return top;
	}
}

const dot = (a: Float64Array, b: Float64Array): number => {
	let s = 0;
	for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
	return s;
};

/**
 * Average-link agglomeration (6.3). Two clusters are candidates only when a candidate edge joins
 * a member of one to a member of the other. The pair with the highest average link (the mean of
 * all member-pair cosines, computed exactly from the vectors) is merged first, while that average
 * is at least `merge` and the merged size is at most `cap`. A chain of near neighbours therefore
 * stops growing once its far ends are no longer similar, which single linkage would not.
 * Deterministic: ties go to the lower minimum seqs. Returns the clusters of size 2 or more as
 * sorted index lists, ordered by their smallest index.
 */
export function agglomerate(input: AgglomerateInput): number[][] {
	const { vectors, seqs, merge, cap } = input;
	const threshold = quantize(merge);
	const clusters: Cluster[] = vectors.map((v, i) => ({
		id: i,
		alive: true,
		members: [i],
		sum: Float64Array.from(v),
		minSeq: seqs[i]!,
		neighbors: new Set<number>(),
	}));
	for (const [i, j] of input.edges) {
		if (i === j) continue;
		clusters[i]!.neighbors.add(j);
		clusters[j]!.neighbors.add(i);
	}
	const heap = new Heap();
	const offer = (a: Cluster, b: Cluster) => {
		if (a.members.length + b.members.length > cap) return;
		const avg = quantize(
			dot(a.sum, b.sum) / (a.members.length * b.members.length),
		);
		if (avg < threshold) return;
		const [x, y] = a.minSeq <= b.minSeq ? [a, b] : [b, a];
		heap.push({
			avg,
			lowSeq: x.minSeq,
			highSeq: y.minSeq,
			a: Math.min(a.id, b.id),
			b: Math.max(a.id, b.id),
		});
	};
	for (const c of clusters)
		for (const j of c.neighbors) if (c.id < j) offer(c, clusters[j]!);

	for (;;) {
		const best = heap.pop();
		if (!best) break;
		const a = clusters[best.a]!;
		const b = clusters[best.b]!;
		if (!a.alive || !b.alive) continue;
		a.alive = b.alive = false;
		const sum = new Float64Array(a.sum.length);
		for (let d = 0; d < sum.length; d++) sum[d] = a.sum[d]! + b.sum[d]!;
		const merged: Cluster = {
			id: clusters.length,
			alive: true,
			members: [...a.members, ...b.members],
			sum,
			minSeq: Math.min(a.minSeq, b.minSeq),
			neighbors: new Set<number>(),
		};
		clusters.push(merged);
		for (const old of [a, b])
			for (const n of old.neighbors) {
				if (n === a.id || n === b.id) continue;
				const other = clusters[n]!;
				other.neighbors.delete(a.id);
				other.neighbors.delete(b.id);
				other.neighbors.add(merged.id);
				merged.neighbors.add(n);
			}
		for (const n of merged.neighbors) offer(merged, clusters[n]!);
	}
	return clusters
		.filter((c) => c.alive && c.members.length >= 2)
		.map((c) => c.members.slice().sort((p, q) => p - q))
		.sort((p, q) => p[0]! - q[0]!);
}
