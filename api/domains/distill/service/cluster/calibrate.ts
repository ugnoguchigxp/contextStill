import type { Database } from "bun:sqlite";
import { sha256Hex } from "../../../../infrastructure/digest";
import { unpackVector } from "../../../../infrastructure/vector";
import {
	DistillError,
	type CalibrationLabel,
	type CalibrationPair,
	type Thresholds,
} from "../../contracts";
import {
	nearestNeighbors,
	runSync,
	runYielding,
	type Neighbor,
} from "./neighbors";
import { assertVectorsUsable, loadPopulation, normalize } from "./population";

/** The similarity bands of 6.2: [low, high), the last one closed at the top. */
export const BANDS: readonly { label: string; low: number; high: number }[] = [
	{ label: "0.86-0.89", low: 0.86, high: 0.89 },
	{ label: "0.89-0.91", low: 0.89, high: 0.91 },
	{ label: "0.91-0.93", low: 0.91, high: 0.93 },
	{ label: "0.93-0.95", low: 0.93, high: 0.95 },
	{ label: "0.95-0.97", low: 0.95, high: 0.97 },
	{ label: "0.97-1.00", low: 0.97, high: Number.POSITIVE_INFINITY },
];
/** Neighbours per row whose pairs are sampled. */
export const SAMPLE_NEIGHBORS = 10;
/** `clusterEdge` keeps at least this share of the `same` pairs. */
export const EDGE_RECALL = 0.95;
/** `clusterMerge` is the lowest threshold above which this share of the pairs is `same`. */
export const MERGE_PURITY = 0.9;

interface PairCandidate {
	pairId: string;
	a: string;
	b: string;
	similarity: number;
	band: number;
	hash: string;
	crossScope: boolean;
	crossShape: boolean;
}

const bandOf = (similarity: number): number =>
	BANDS.findIndex((b) => similarity >= b.low && similarity < b.high);

/** The id of a pair: the two knowledge ids in order. */
export const pairIdOf = (x: string, y: string): string =>
	x < y ? `${x}:${y}` : `${y}:${x}`;

export function splitPairId(pairId: string): [string, string] {
	const parts = pairId.split(":");
	if (parts.length !== 2 || !parts[0] || !parts[1] || parts[0] >= parts[1])
		throw new DistillError("invalid_distill_request");
	return [parts[0], parts[1]];
}

/**
 * `n` pairs for the labelling: the pairs of each atom with its 10 nearest neighbours (population:
 * judged general or generalizable, with a usable vector), taken evenly from the six similarity
 * bands, in the order of sha256(pairId) so the same data gives the same sample. In each band the
 * pairs across scopes (scope or repo differ) and across type or polarity are drawn first, up to
 * their share of the band, so they are not rarer in the sample than in the data.
 */
export function sampleCalibration(
	db: Database,
	spaceKey: string,
	n: number,
): CalibrationPair[] {
	const atoms = readSampleAtoms(db, spaceKey, n);
	const neighbors = runSync(sampleNeighbors(atoms));
	return attachText(db, pickSample(atoms, neighbors, n));
}

/**
 * The same sample without holding the event loop: the neighbour search yields between chunks.
 * `read` is the store's read (the population and the text are read in two short reads, the
 * search itself runs on the copy of the vectors). The service's `calibrationSample` uses this one;
 * the synchronous function above is the module's for tests and small populations.
 */
export async function sampleCalibrationYielding(
	read: <T>(operation: (db: Database) => T) => T,
	spaceKey: string,
	n: number,
): Promise<CalibrationPair[]> {
	const atoms = read((db) => readSampleAtoms(db, spaceKey, n));
	const neighbors = await runYielding(sampleNeighbors(atoms));
	const chosen = pickSample(atoms, neighbors, n);
	return read((db) => attachText(db, chosen));
}

type SampleAtom = ReturnType<typeof loadPopulation>["usable"][number];

function readSampleAtoms(
	db: Database,
	spaceKey: string,
	n: number,
): SampleAtom[] {
	if (!Number.isInteger(n) || n < 1)
		throw new DistillError("invalid_distill_request");
	const population = loadPopulation(db, spaceKey);
	assertVectorsUsable(population, false);
	return population.usable;
}

const sampleNeighbors = (atoms: readonly SampleAtom[]) =>
	nearestNeighbors(
		atoms.map((a) => a.vector!),
		SAMPLE_NEIGHBORS,
		BANDS[0]!.low,
	);

function pickSample(
	atoms: readonly SampleAtom[],
	neighbors: readonly (readonly Neighbor[])[],
	n: number,
): PairCandidate[] {
	const seen = new Map<string, PairCandidate>();
	neighbors.forEach((list, i) => {
		for (const { index: j, similarity } of list) {
			const a = atoms[i]!;
			const b = atoms[j]!;
			const pairId = pairIdOf(a.id, b.id);
			if (seen.has(pairId)) continue;
			const band = bandOf(similarity);
			if (band < 0) continue;
			const [first, second] = a.id < b.id ? [a, b] : [b, a];
			seen.set(pairId, {
				pairId,
				a: first.id,
				b: second.id,
				similarity,
				band,
				hash: sha256Hex(pairId),
				crossScope:
					first.scope !== second.scope || first.repoKey !== second.repoKey,
				crossShape:
					first.type !== second.type || first.polarity !== second.polarity,
			});
		}
	});

	const base = Math.floor(n / BANDS.length);
	const extra = n % BANDS.length;
	const chosen: PairCandidate[] = [];
	BANDS.forEach((_, band) => {
		const quota = base + (band < extra ? 1 : 0);
		const inBand = [...seen.values()]
			.filter((p) => p.band === band)
			.sort((p, q) => (p.hash < q.hash ? -1 : p.hash > q.hash ? 1 : 0));
		if (inBand.length === 0 || quota === 0) return;
		const picked = new Set<PairCandidate>();
		const add = (list: PairCandidate[], count: number) => {
			for (const p of list) {
				if (count <= 0 || picked.size >= quota) return;
				if (picked.has(p)) continue;
				picked.add(p);
				count--;
			}
		};
		const share = (flag: (p: PairCandidate) => boolean) =>
			Math.ceil((quota * inBand.filter(flag).length) / inBand.length);
		const scopeList = inBand.filter((p) => p.crossScope);
		const shapeList = inBand.filter((p) => p.crossShape);
		add(
			scopeList,
			share((p) => p.crossScope),
		);
		add(
			shapeList,
			share((p) => p.crossShape) -
				[...picked].filter((p) => p.crossShape).length,
		);
		add(inBand, quota);
		chosen.push(...inBand.filter((p) => picked.has(p)));
	});

	return chosen;
}

function attachText(
	db: Database,
	chosen: readonly PairCandidate[],
): CalibrationPair[] {
	const text = new Map<string, { title: string; body: string }>();
	const ids = [...new Set(chosen.flatMap((p) => [p.a, p.b]))];
	for (let i = 0; i < ids.length; i += 500) {
		const part = ids.slice(i, i + 500);
		const rows = db
			.query(
				`SELECT id, title, body FROM knowledge_items WHERE id IN (${part.map(() => "?").join(", ")})`,
			)
			.all(...part) as { id: string; title: string; body: string }[];
		for (const r of rows) text.set(r.id, { title: r.title, body: r.body });
	}
	return chosen.map((p) => ({
		pairId: p.pairId,
		similarity: p.similarity,
		bin: BANDS[p.band]!.label,
		a: {
			id: p.a,
			title: text.get(p.a)?.title ?? "",
			body: text.get(p.a)?.body ?? "",
		},
		b: {
			id: p.b,
			title: text.get(p.b)?.title ?? "",
			body: text.get(p.b)?.body ?? "",
		},
	}));
}

export interface LabelledPair {
	similarity: number;
	same: boolean;
}

// The slack (in units of 1e-4) absorbs the Float32 error of a stored vector: 0.95 may be 0.94999999.
const floor4 = (x: number) => Math.floor(x * 1e4 + 2e-3) / 1e4;
const ceil4 = (x: number) => Math.ceil(x * 1e4 - 2e-3) / 1e4;

export interface CalibrationResult {
	clusterEdge: number;
	clusterMerge: number;
	pairCandidate: number;
	/** Descriptive numbers of the fit, kept next to the thresholds. */
	detail: Record<string, number>;
}

/**
 * The thresholds of 6.2 from labelled pairs (`unsure` already removed).
 *  - clusterEdge: the largest threshold that keeps at least 95% of the `same` pairs at or above
 *    it, i.e. the k-th highest similarity among the `same` pairs with k = ceil(0.95 * count).
 *  - clusterMerge: the smallest threshold from which up to the top at least 90% of the pairs
 *    at or above it are `same` (1.0 when none qualifies: nothing merges).
 *  - pairCandidate: clusterEdge - 0.03.
 * The values are rounded to four decimals in the safe direction (edge down, merge up).
 */
export function fitThresholds(
	pairs: readonly LabelledPair[],
): CalibrationResult {
	const sames = pairs
		.filter((p) => p.same)
		.map((p) => p.similarity)
		.sort((x, y) => y - x);
	if (sames.length === 0) throw new DistillError("invalid_distill_request");
	const k = Math.ceil(EDGE_RECALL * sames.length - 1e-9);
	const clusterEdge = floor4(sames[k - 1]!);

	let clusterMerge = 1;
	const thresholds = [...new Set(pairs.map((p) => p.similarity))].sort(
		(x, y) => x - y,
	);
	for (const t of thresholds) {
		const above = pairs.filter((p) => p.similarity >= t);
		if (above.filter((p) => p.same).length / above.length >= MERGE_PURITY) {
			clusterMerge = Math.min(1, ceil4(t));
			break;
		}
	}
	return {
		clusterEdge,
		clusterMerge,
		pairCandidate: Math.max(0, floor4(clusterEdge - 0.03)),
		detail: { same: sames.length, different: pairs.length - sames.length },
	};
}

/** The cosine of the two atoms' stored vectors; the pair is invalid when one has none. */
export function pairSimilarity(
	db: Database,
	spaceKey: string,
	a: string,
	b: string,
): number {
	const rows = db
		.query(
			`SELECT owner_id AS id, vector FROM vectors
			 WHERE owner_kind = 'knowledge' AND space_key = ? AND owner_id IN (?, ?)`,
		)
		.all(spaceKey, a, b) as { id: string; vector: Uint8Array }[];
	const va = rows.find((r) => r.id === a);
	const vb = rows.find((r) => r.id === b);
	if (!va || !vb) throw new DistillError("invalid_distill_request");
	const x = normalize(unpackVector(va.vector));
	const y = normalize(unpackVector(vb.vector));
	let dot = 0;
	for (let i = 0; i < Math.min(x.length, y.length); i++) dot += x[i]! * y[i]!;
	return dot;
}

/** Labels to thresholds. `unsure` pairs do not count. */
export function calibrate(
	db: Database,
	spaceKey: string,
	labels: readonly CalibrationLabel[],
	current: Thresholds,
	now: string,
): { thresholds: Thresholds; detail: Record<string, unknown> } {
	const latest = new Map<string, CalibrationLabel>();
	for (const l of labels) latest.set(l.pairId, l);
	const pairs: LabelledPair[] = [];
	const counts = { same: 0, different: 0, unsure: 0, owner: 0, agentDraft: 0 };
	for (const l of latest.values()) {
		counts[l.label]++;
		if (l.labelSource === "owner") counts.owner++;
		else counts.agentDraft++;
		if (l.label === "unsure") continue;
		const [a, b] = splitPairId(l.pairId);
		pairs.push({
			similarity: pairSimilarity(db, spaceKey, a, b),
			same: l.label === "same",
		});
	}
	const fit = fitThresholds(pairs);
	return {
		thresholds: {
			...current,
			clusterEdge: fit.clusterEdge,
			clusterMerge: fit.clusterMerge,
			pairCandidate: fit.pairCandidate,
			calibratedAt: now,
		},
		detail: { labels: counts, ...fit.detail },
	};
}
