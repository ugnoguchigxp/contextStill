import type { Database } from "bun:sqlite";
import { dot } from "../../../../infrastructure/vector";
import { getKnowledgeById } from "../../../knowledge";
import { getVector } from "../../../vectors";
import { getPairJudgment, getThresholds } from "../../repository";
import type { DistillDeps } from "../../contracts";
import { runSync, runYielding } from "../cluster/neighbors";
import { listActiveCanonicals, type CanonicalListing } from "./reads";

/** The neighbours looked at for each canonical (6.5). */
export const NEIGHBOURS = 5;

export interface CandidatePair {
	/** a < b */
	a: string;
	b: string;
	aDigest: string;
	bDigest: string;
	/** Cosine of the two canonical vectors; null for a pair that only shares a claim cluster. */
	similarity: number | null;
	reason: "neighbour" | "cluster";
}

export interface CandidateScan {
	/** Every candidate pair, judged or not, sorted by (a, b). */
	pairs: CandidatePair[];
	/** Active canonicals without a vector that matches their current text. */
	withoutVector: string[];
}

const orderKey = (x: string, y: string): [string, string] =>
	x <= y ? [x, y] : [y, x];

/** What `scanSteps` needs, loaded in one read; the computation after it touches no database. */
export interface ScanInput {
	items: CanonicalListing[];
	vectors: Map<string, Float32Array>;
	withoutVector: string[];
	pairCandidate: number;
}

export function loadScanInput(
	db: Database,
	spaceKey: string,
	pairCandidate = getThresholds(db).pairCandidate,
): ScanInput {
	const items = listActiveCanonicals(db);
	const vectors = new Map<string, Float32Array>();
	const withoutVector: string[] = [];
	for (const item of items) {
		const stored = getVector(db, "knowledge", item.id, spaceKey);
		if (stored && stored.contentDigest === item.contentDigest)
			vectors.set(item.id, stored.vector);
		else withoutVector.push(item.id);
	}
	return { items, vectors, withoutVector, pairCandidate };
}

/**
 * The computation of `scanCandidates` as a generator that yields after every canonical (a row
 * of N dot products), so that a caller can let the event loop run. Its return value is the scan.
 */
export function* scanSteps(
	input: ScanInput,
): Generator<void, CandidateScan, void> {
	const { items, vectors, withoutVector, pairCandidate } = input;
	const digestOf = new Map(items.map((i) => [i.id, i.contentDigest]));
	const found = new Map<string, CandidatePair>();
	const add = (
		x: string,
		y: string,
		similarity: number | null,
		reason: CandidatePair["reason"],
	) => {
		const [a, b] = orderKey(x, y);
		const key = `${a}\u0000${b}`;
		const before = found.get(key);
		if (before) {
			if (before.similarity === null && similarity !== null)
				before.similarity = similarity;
			return;
		}
		found.set(key, {
			a,
			b,
			aDigest: digestOf.get(a)!,
			bDigest: digestOf.get(b)!,
			similarity,
			reason,
		});
	};

	const ids = [...vectors.keys()];
	for (const id of ids) {
		const query = vectors.get(id)!;
		const scored: { id: string; score: number }[] = [];
		for (const other of ids) {
			if (other === id) continue;
			const score = dot(query, vectors.get(other)!);
			if (score >= pairCandidate) scored.push({ id: other, score });
		}
		// Higher score first; the id breaks ties so the choice is deterministic.
		scored.sort((x, y) => y.score - x.score || (x.id < y.id ? -1 : 1));
		for (const n of scored.slice(0, NEIGHBOURS))
			add(id, n.id, n.score, "neighbour");
		yield;
	}

	const byCluster = new Map<string, string[]>();
	for (const item of items)
		if (item.clusterId !== null) {
			const list = byCluster.get(item.clusterId) ?? [];
			list.push(item.id);
			byCluster.set(item.clusterId, list);
		}
	for (const members of byCluster.values()) {
		for (let i = 0; i < members.length; i++)
			for (let j = i + 1; j < members.length; j++) {
				const x = vectors.get(members[i]!);
				const y = vectors.get(members[j]!);
				add(members[i]!, members[j]!, x && y ? dot(x, y) : null, "cluster");
			}
		yield;
	}

	return {
		pairs: [...found.values()].sort((x, y) =>
			x.a === y.a ? (x.b < y.b ? -1 : 1) : x.a < y.a ? -1 : 1,
		),
		withoutVector,
	};
}

/**
 * The candidate pairs of 6.5: for each active canonical, the neighbours among the active
 * canonicals (by the vector of the text with the situation first) with a cosine of at least
 * `pairCandidate`, at most `NEIGHBOURS` of them; and the canonicals the canonical stage made
 * from the same claim cluster. A canonical whose vector is missing or made from other text
 * contributes no neighbour pair (the audit reports it as canonical_without_vector).
 *
 * This form runs to the end without letting the event loop run; it is for tests and small sets.
 * The backend uses `scanCandidatesYielding`.
 */
export function scanCandidates(
	db: Database,
	spaceKey: string,
	pairCandidate?: number,
): CandidateScan {
	return runSync(scanSteps(loadScanInput(db, spaceKey, pairCandidate)));
}

/** `scanCandidates` in reads of its own and with the event loop let run between canonicals. */
export function scanCandidatesYielding(
	store: DistillDeps["store"],
	spaceKey: string,
): Promise<CandidateScan> {
	return runYielding(scanLoop(store, spaceKey));
}

function* scanLoop(
	store: DistillDeps["store"],
	spaceKey: string,
): Generator<void, CandidateScan, void> {
	const input = store.read((db) => loadScanInput(db, spaceKey));
	return yield* scanSteps(input);
}

const JUDGED_CHUNK = 500;

/**
 * The pairs without a judgment of their current texts, as a generator: the scan, then the
 * lookups in reads of `JUDGED_CHUNK` pairs, yielding between them.
 */
export function* unjudgedSteps(
	store: DistillDeps["store"],
	spaceKey: string,
): Generator<void, CandidatePair[], void> {
	const scan = yield* scanLoop(store, spaceKey);
	const out: CandidatePair[] = [];
	for (let i = 0; i < scan.pairs.length; i += JUDGED_CHUNK) {
		const chunk = scan.pairs.slice(i, i + JUDGED_CHUNK);
		out.push(...store.read((db) => chunk.filter((p) => !isJudged(db, p))));
		yield;
	}
	return out;
}

/** True when a judgment exists for exactly the current texts of both sides. */
export function isJudged(db: Database, pair: CandidatePair): boolean {
	const j = getPairJudgment(db, pair.a, pair.b);
	return j !== null && j.aDigest === pair.aDigest && j.bDigest === pair.bDigest;
}

/** The candidate pairs that have no judgment for their current texts. */
export function unjudgedCandidates(
	db: Database,
	spaceKey: string,
): CandidatePair[] {
	return scanCandidates(db, spaceKey).pairs.filter((p) => !isJudged(db, p));
}

/** Rows of a pair as the judge sees them; null when either is not a known item. */
export function loadPair(db: Database, a: string, b: string) {
	const x = getKnowledgeById(db, a);
	const y = getKnowledgeById(db, b);
	return x && y ? { a: x, b: y } : null;
}

/** `unjudgedCandidates` with the event loop let run (see `scanCandidatesYielding`). */
export function unjudgedCandidatesYielding(
	store: DistillDeps["store"],
	spaceKey: string,
): Promise<CandidatePair[]> {
	return runYielding(unjudgedSteps(store, spaceKey));
}
