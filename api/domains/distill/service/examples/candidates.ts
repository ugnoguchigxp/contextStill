import { dot } from "../../../../infrastructure/vector";

/** Episodes taken because they share an original record with the canonical's atoms. */
export const SOURCE_CANDIDATES = 4;
/** Episodes taken because their vector is near the canonical's. */
export const NEAR_CANDIDATES = 3;

export interface EpisodeCandidate {
	id: string;
	via: "source" | "vector";
	/** Cosine similarity to the canonical when both vectors are known. */
	similarity: number | null;
}

export interface EpisodeMatrix {
	ids: string[];
	vectors: Float32Array[];
}

/**
 * The candidates of one canonical (6.9): first the episodes of the same original record (decided
 * by the data, ordered by id), then the nearest episodes whose similarity reaches `threshold`
 * (`pairCandidate`), best first, ties by id. An episode appears once.
 */
export function pickCandidates(args: {
	sameSource: readonly string[];
	vector: Float32Array | null;
	matrix: EpisodeMatrix;
	threshold: number;
}): EpisodeCandidate[] {
	const byId = new Map<string, number>();
	args.matrix.ids.forEach((id, i) => byId.set(id, i));
	const similarityOf = (id: string): number | null => {
		const i = byId.get(id);
		const v = i === undefined ? undefined : args.matrix.vectors[i];
		return args.vector && v && v.length === args.vector.length
			? dot(args.vector, v)
			: null;
	};
	const out: EpisodeCandidate[] = [...new Set(args.sameSource)]
		.sort()
		.slice(0, SOURCE_CANDIDATES)
		.map((id) => ({ id, via: "source", similarity: similarityOf(id) }));
	if (args.vector) {
		const taken = new Set(out.map((c) => c.id));
		const near: EpisodeCandidate[] = [];
		args.matrix.ids.forEach((id, i) => {
			if (taken.has(id)) return;
			const v = args.matrix.vectors[i]!;
			if (v.length !== args.vector!.length) return;
			const similarity = dot(args.vector!, v);
			if (similarity >= args.threshold)
				near.push({ id, via: "vector", similarity });
		});
		near.sort(
			(a, b) =>
				b.similarity! - a.similarity! ||
				(a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
		);
		out.push(...near.slice(0, NEAR_CANDIDATES));
	}
	return out;
}
