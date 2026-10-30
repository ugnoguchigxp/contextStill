import { sha256Hex } from "../../../../infrastructure/digest";
import { dot } from "../../../../infrastructure/vector";

export interface KMeansResult {
	/** assignments[i] is the cluster of point i (the order of the input). */
	assignments: number[];
	/** One unit vector per cluster; every cluster has at least one point. */
	centers: Float32Array[];
	iterations: number;
}

export interface KMeansOptions {
	maxIterations?: number;
	/** Points between two turns given back to the event loop (0 never yields). */
	yieldEvery?: number;
}

const SEED = "context-still:theme-kmeans:v1";
const yieldTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

function unit(v: Float32Array): Float32Array {
	let sum = 0;
	for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!;
	const norm = Math.sqrt(sum);
	const out = new Float32Array(v.length);
	if (norm === 0) return out;
	for (let i = 0; i < v.length; i++) out[i] = v[i]! / norm;
	return out;
}

/** The normalised copy of a vector. */
export const normalized = unit;

/** A number in [0, 1) that depends only on `label`. */
function uniform(label: string): number {
	return (
		Number.parseInt(sha256Hex(`${SEED}:${label}`).slice(0, 8), 16) / 2 ** 32
	);
}

/**
 * Spherical k-means (cosine similarity on unit vectors) whose result depends only on the set of
 * (id, vector) pairs, never on the order they are given in:
 *  - the points are visited in the order of sha256(id);
 *  - the first center is the first point of that order; the others are drawn k-means++ style
 *    (probability proportional to the squared distance 1 - cos to the nearest chosen center),
 *    with the uniform numbers taken from sha256 of the draw number instead of a random source;
 *  - a point goes to the center with the largest dot product, the lowest center number on a tie;
 *  - a center is the normalised sum of its points, added in the sha256 order;
 *  - an emptied cluster takes the point least like its own center.
 * `k` is limited to the number of points.
 */
export async function sphericalKMeans(
	ids: readonly string[],
	vectors: readonly Float32Array[],
	k: number,
	options: KMeansOptions = {},
): Promise<KMeansResult> {
	const n = vectors.length;
	if (ids.length !== n) throw new Error("kmeans_ids_mismatch");
	if (n === 0) return { assignments: [], centers: [], iterations: 0 };
	const dim = vectors[0]!.length;
	const clusters = Math.max(1, Math.min(Math.round(k), n));
	const maxIterations = options.maxIterations ?? 40;
	const yieldEvery = options.yieldEvery ?? 256;
	const points = vectors.map(unit);

	const hashes = ids.map((id) => sha256Hex(id));
	const order = Array.from({ length: n }, (_, i) => i).sort(
		(a, b) =>
			(hashes[a]! < hashes[b]! ? -1 : hashes[a]! > hashes[b]! ? 1 : 0) ||
			(ids[a]! < ids[b]! ? -1 : ids[a]! > ids[b]! ? 1 : 0),
	);

	// k-means++ with a deterministic source of uniform numbers.
	const centers: Float32Array[] = [points[order[0]!]!.slice()];
	const nearest = new Float64Array(n).fill(Number.POSITIVE_INFINITY);
	const chosen = new Set<number>([order[0]!]);
	const refresh = (center: Float32Array) => {
		for (let i = 0; i < n; i++) {
			const d = Math.max(0, 1 - dot(points[i]!, center));
			if (d < nearest[i]!) nearest[i] = d;
		}
	};
	refresh(centers[0]!);
	while (centers.length < clusters) {
		let total = 0;
		for (const i of order) total += chosen.has(i) ? 0 : nearest[i]! ** 2;
		let pick = -1;
		if (total > 0) {
			const target = uniform(String(centers.length)) * total;
			let cumulative = 0;
			for (const i of order) {
				if (chosen.has(i)) continue;
				cumulative += nearest[i]! ** 2;
				pick = i;
				if (cumulative > target) break;
			}
		} else {
			// Every remaining point equals a chosen center.
			pick = order.find((i) => !chosen.has(i)) ?? -1;
		}
		if (pick < 0) break;
		chosen.add(pick);
		centers.push(points[pick]!.slice());
		refresh(centers[centers.length - 1]!);
		if (yieldEvery > 0) await yieldTurn();
	}

	const assignments = Array.from({ length: n }, () => -1);
	const best = new Float64Array(n);
	let iterations = 0;
	for (; iterations < maxIterations; iterations++) {
		let changed = false;
		for (let i = 0; i < n; i++) {
			let bestCenter = 0;
			let bestScore = Number.NEGATIVE_INFINITY;
			for (let c = 0; c < centers.length; c++) {
				const score = dot(points[i]!, centers[c]!);
				if (score > bestScore) {
					bestScore = score;
					bestCenter = c;
				}
			}
			best[i] = bestScore;
			if (assignments[i] !== bestCenter) {
				assignments[i] = bestCenter;
				changed = true;
			}
			if (yieldEvery > 0 && i % yieldEvery === yieldEvery - 1)
				await yieldTurn();
		}
		const sums = centers.map(() => new Float64Array(dim));
		const counts = Array.from({ length: centers.length }, () => 0);
		for (const i of order) {
			const sum = sums[assignments[i]!]!;
			const p = points[i]!;
			for (let d = 0; d < dim; d++) sum[d]! += p[d]!;
			counts[assignments[i]!]!++;
		}
		const taken = new Set<number>();
		for (let c = 0; c < centers.length; c++) {
			if (counts[c]! > 0) {
				const next = unit(Float32Array.from(sums[c]!));
				if (next.some((x) => x !== 0)) {
					centers[c] = next;
					continue;
				}
			}
			// Emptied (or cancelled out): the point least like its center becomes the center.
			let far = -1;
			for (const i of order) {
				if (taken.has(i)) continue;
				if (far < 0 || best[i]! < best[far]!) far = i;
			}
			if (far >= 0) {
				taken.add(far);
				centers[c] = points[far]!.slice();
				best[far] = 1;
				changed = true;
			}
		}
		if (!changed) {
			iterations++;
			break;
		}
	}
	// Drop clusters that ended empty and renumber in the order of their first point's hash.
	const rank = new Map<number, number>();
	for (const i of order) {
		const c = assignments[i]!;
		if (!rank.has(c)) rank.set(c, rank.size);
	}
	const finalCenters: Float32Array[] = [];
	for (const [old, index] of rank) finalCenters[index] = centers[old]!;
	return {
		assignments: assignments.map((c) => rank.get(c)!),
		centers: finalCenters,
		iterations,
	};
}
