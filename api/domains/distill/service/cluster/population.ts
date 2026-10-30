import type { Database } from "bun:sqlite";
import { unpackVector } from "../../../../infrastructure/vector";
import { DistillError } from "../../contracts";

/** The most rows of the population that may lack a usable vector (6.0). */
export const MAX_UNUSABLE_RATIO = 0.01;

export interface Atom {
	id: string;
	seq: number;
	contentDigest: string;
	scope: string;
	repoKey: string | null;
	type: string;
	polarity: string;
	/** L2-normalised copy of the stored vector; null when the row has no usable vector. */
	vector: Float32Array | null;
}

export interface Population {
	/** Every row of the population, in seq order. */
	atoms: Atom[];
	/** The rows with a usable vector. */
	usable: Atom[];
	/** Rows of the population without one. */
	unusable: number;
}

export function normalize(v: Float32Array): Float32Array {
	let sum = 0;
	for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!;
	const out = new Float32Array(v.length);
	if (sum === 0) return out;
	const norm = Math.sqrt(sum);
	for (let i = 0; i < v.length; i++) out[i] = v[i]! / norm;
	return out;
}

/**
 * The population of 6.3: active atoms that search may return (`retrieval = 'searchable'`), not
 * of the `personal` space (no rule is made from a personal original record until N6), and
 * were judged `general` or `generalizable` for the text they have now. A vector is usable when
 * it was made from that text and is LARM-made or verified (and not `mismatch`/`stale`); with
 * `allowUnverified` an unverified legacy vector is usable too (pilot only).
 */
export function loadPopulation(
	db: Database,
	spaceKey: string,
	o: { allowUnverified?: boolean; limit?: number } = {},
): Population {
	const rows = db
		.query(
			`SELECT k.id AS id, k.seq AS seq, k.content_digest AS digest, k.scope AS scope,
			        k.repo_key AS repoKey, k.type AS type, k.polarity AS polarity,
			        v.vector AS vector, v.content_digest AS vdigest, v.origin AS origin,
			        v.verification AS verification
			 FROM knowledge_items k
			 JOIN distill_assessments a ON a.owner_kind = 'knowledge' AND a.owner_id = k.id
			 LEFT JOIN vectors v ON v.owner_kind = 'knowledge' AND v.owner_id = k.id AND v.space_key = ?
			 WHERE k.layer = 'atom' AND k.status = 'active' AND k.retrieval = 'searchable'
			   AND k.space <> 'personal'
			   AND a.generality IN ('general', 'generalizable') AND a.content_digest = k.content_digest
			 ORDER BY k.seq LIMIT ?`,
		)
		.all(spaceKey, o.limit ?? -1) as {
		id: string;
		seq: number;
		digest: string;
		scope: string;
		repoKey: string | null;
		type: string;
		polarity: string;
		vector: Uint8Array | null;
		vdigest: string | null;
		origin: string | null;
		verification: string | null;
	}[];
	const atoms: Atom[] = [];
	const usable: Atom[] = [];
	for (const r of rows) {
		const ok =
			r.vector !== null &&
			r.vdigest === r.digest &&
			r.verification !== "mismatch" &&
			r.verification !== "stale" &&
			(r.origin === "larm" ||
				r.verification === "verified" ||
				o.allowUnverified === true);
		const atom: Atom = {
			id: r.id,
			seq: r.seq,
			contentDigest: r.digest,
			scope: r.scope,
			repoKey: r.repoKey,
			type: r.type,
			polarity: r.polarity,
			vector: ok ? normalize(unpackVector(r.vector!)) : null,
		};
		atoms.push(atom);
		if (ok) usable.push(atom);
	}
	return { atoms, usable, unusable: atoms.length - usable.length };
}

/** `distill_vectors_unverified` when more than 1% of the population has no usable vector. */
export function assertVectorsUsable(
	p: Population,
	allowUnverified: boolean | undefined,
): void {
	if (!allowUnverified && p.unusable > p.atoms.length * MAX_UNUSABLE_RATIO)
		throw new DistillError("distill_vectors_unverified");
}
