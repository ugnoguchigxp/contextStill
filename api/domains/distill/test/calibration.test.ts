import { afterEach, expect, test } from "bun:test";
import { sha256Hex } from "../../../infrastructure/digest";
import { getKnowledgeById } from "../../knowledge";
import { upsertVector } from "../../vectors";
import {
	DistillError,
	type CalibrationLabel,
	type Generality,
} from "../contracts";
import { getParam, getThresholds, upsertAssessment } from "../repository";
import { BANDS, createCluster, fitThresholds } from "../service/cluster";
import { sampleCalibrationYielding } from "../service/cluster/calibrate";
import {
	nearestNeighbors,
	runSync,
	runYielding,
	YIELD_WORK,
} from "../service/cluster/neighbors";
import { atom, createTestDistill, seedAtoms, T0 } from "./fixtures";

const ts: ReturnType<typeof createTestDistill>[] = [];
afterEach(async () => {
	for (const t of ts.splice(0)) await t.dispose();
});
type T = ReturnType<typeof createTestDistill>;
const setup = () => {
	const t = createTestDistill();
	ts.push(t);
	return t;
};

interface PairSpec {
	/** Cosine of the two atoms. */
	cosine: number;
	x?: Parameters<typeof atom>[1];
	y?: Parameters<typeof atom>[1];
	generality?: Generality;
}

/**
 * Pairs of atoms: pair p lives in its own two dimensions, so atoms of different pairs are
 * orthogonal and the only neighbour of an atom is its partner. Ids are `p00a`/`p00b`.
 */
async function pairWorld(t: T, pairs: PairSpec[]): Promise<void> {
	const dim = pairs.length * 2;
	const name = (p: number, side: "a" | "b") =>
		`p${String(p).padStart(2, "0")}${side}`;
	await seedAtoms(
		t.deps,
		pairs.flatMap((s, p) => [atom(name(p, "a"), s.x), atom(name(p, "b"), s.y)]),
	);
	await t.deps.store.write((db) => {
		db.query(
			`INSERT INTO vector_spaces
			   (space_key, model_id, revision, artifact_digest, dimension, descriptor_json, created_at)
			 VALUES (?, 'fixture', '1', 'x', ?, '{}', ?)`,
		).run(t.deps.spaceKey, dim, T0);
		pairs.forEach((s, p) => {
			const theta = Math.acos(s.cosine);
			for (const [side, angle] of [
				["a", 0],
				["b", theta],
			] as const) {
				const id = name(p, side);
				const row = getKnowledgeById(db, id)!;
				const v = new Float32Array(dim);
				v[2 * p] = Math.cos(angle);
				v[2 * p + 1] = Math.sin(angle);
				upsertAssessment(db, {
					ownerKind: "knowledge",
					ownerId: id,
					generality: s.generality ?? "general",
					signals: {},
					reason: "",
					origin: "llm",
					contentDigest: row.contentDigest,
					promptVersion: "assess.v1",
					callId: null,
					at: T0,
				});
				upsertVector(db, {
					ownerKind: "knowledge",
					ownerId: id,
					spaceKey: t.deps.spaceKey,
					contentDigest: row.contentDigest,
					vector: v,
					origin: "larm",
					verification: "verified",
					now: T0,
				});
			}
		});
	});
}

/** The cosine in the middle of each band. */
const MIDDLE = [0.875, 0.9, 0.92, 0.94, 0.96, 0.985];

function bandedPairs(perBand: number): PairSpec[] {
	return MIDDLE.flatMap((cosine) =>
		Array.from({ length: perBand }, (_, i): PairSpec => {
			// 12 per band: 6 across type (i 0..5), 3 across scope (i 6..8)
			if (i < 6) return { cosine, y: { type: "procedure" } };
			if (i < 9) return { cosine, y: { scope: "repo", repoKey: "app" } };
			return { cosine };
		}),
	);
}

test("the sample takes the same number of pairs from each band, the same ones every time", async () => {
	const t = setup();
	await pairWorld(t, bandedPairs(12));
	const module = createCluster(t.deps);

	const sample = module.calibrationSample(30);
	expect(sample).toHaveLength(30);
	for (const band of BANDS)
		expect(sample.filter((p) => p.bin === band.label)).toHaveLength(5);
	for (const p of sample) {
		const band = BANDS.find((b) => b.label === p.bin)!;
		expect(p.similarity).toBeGreaterThanOrEqual(band.low);
		expect(p.similarity).toBeLessThan(band.high);
		expect(p.a.id < p.b.id).toBe(true);
		expect(p.pairId).toBe(`${p.a.id}:${p.b.id}`);
		expect(p.a.title).toBe(`title ${p.a.id}`);
		expect(p.b.body).toBe(`body ${p.b.id}`);
	}
	// Deterministic, and independent of how often it is asked.
	expect(module.calibrationSample(30)).toEqual(sample);
	expect(createCluster(t.deps).calibrationSample(30)).toEqual(sample);

	// Inside a band the order is sha256(pairId), after the pairs drawn for their kind.
	const band = sample.filter((p) => p.bin === "0.93-0.95");
	expect(band.map((p) => p.pairId)).toEqual(
		band
			.map((p) => p.pairId)
			.sort((p, q) => (sha256Hex(p) < sha256Hex(q) ? -1 : 1)),
	);

	// The pairs across scopes (25% of a band) and across types (50%) are not rarer in the
	// sample than in the data: at least ceil(5 * 0.25) = 2 and ceil(5 * 0.5) = 3.
	for (const b of BANDS) {
		const picked = sample.filter((p) => p.bin === b.label);
		const idx = (p: (typeof sample)[number]) => Number(p.a.id.slice(1, 3)) % 12;
		expect(
			picked.filter((p) => idx(p) >= 6 && idx(p) < 9).length,
		).toBeGreaterThanOrEqual(2);
		expect(picked.filter((p) => idx(p) < 6).length).toBeGreaterThanOrEqual(3);
	}
});

test("n that does not divide by six gives the first bands one more; a band with few pairs gives all", async () => {
	const t = setup();
	await pairWorld(t, [
		...MIDDLE.slice(0, 5).flatMap((cosine) =>
			Array.from({ length: 4 }, (): PairSpec => ({ cosine })),
		),
		{ cosine: 0.985 },
		{ cosine: 0.99 },
	]);
	const sample = createCluster(t.deps).calibrationSample(26);
	// base 4, 2 left over: the first two bands get 5, but each has only 4 pairs
	const count = (label: string) => sample.filter((p) => p.bin === label).length;
	expect(count("0.86-0.89")).toBe(4);
	expect(count("0.89-0.91")).toBe(4);
	expect(count("0.97-1.00")).toBe(2);
	// pairs outside every band (below 0.86) are not offered
	const low = setup();
	await pairWorld(low, [{ cosine: 0.8 }, { cosine: 0.9 }]);
	expect(createCluster(low.deps).calibrationSample(12)).toHaveLength(1);
});

test("rows that are not general or generalizable, or lack a verified vector, are not sampled", async () => {
	const t = setup();
	await pairWorld(t, [
		{ cosine: 0.9 },
		{ cosine: 0.9, generality: "repo_specific" },
		{ cosine: 0.9, generality: "unusable" },
	]);
	const sample = createCluster(t.deps).calibrationSample(6);
	expect(sample.map((p) => p.pairId)).toEqual(["p00a:p00b"]);

	await t.deps.store.write((db) =>
		db
			.query(
				"UPDATE vectors SET origin = 'legacy_import', verification = 'unverified'",
			)
			.run(),
	);
	expect(() => createCluster(t.deps).calibrationSample(6)).toThrow(
		"distill_vectors_unverified",
	);
	expect(() => createCluster(t.deps).calibrationSample(0)).toThrow(
		"invalid_distill_request",
	);
});

// 20 pairs the labeller calls the same claim, 7 different. By hand:
//  same:      0.99 0.985 0.98 0.975 0.97 0.965 0.96 0.955 0.95 0.945 0.94 0.935 0.93
//             0.925 0.92 0.915 0.91 0.905 0.90 0.89
//  different: 0.93 0.92 0.91 0.88 0.87 0.86 0.85
//  clusterEdge: ceil(0.95 * 20) = 19 pairs must stay above it: the 19th highest is 0.90.
//  clusterMerge: purity of the pairs at or above t is
//    0.91 -> 17/20 = 0.85, 0.915 -> 16/18 = 0.889, 0.92 -> 15/17 = 0.882, 0.925 -> 14/15 = 0.933
//    so 0.925 is the lowest threshold with purity >= 0.90.
const SAME = [
	0.99, 0.985, 0.98, 0.975, 0.97, 0.965, 0.96, 0.955, 0.95, 0.945, 0.94, 0.935,
	0.93, 0.925, 0.92, 0.915, 0.91, 0.905, 0.9, 0.89,
];
const DIFFERENT = [0.93, 0.92, 0.91, 0.88, 0.87, 0.86, 0.85];

test("the thresholds follow the labels as worked out by hand", async () => {
	const t = setup();
	const labelled = [
		...SAME.map((cosine) => ({ cosine, label: "same" as const })),
		...DIFFERENT.map((cosine) => ({ cosine, label: "different" as const })),
		// unsure pairs do not count, even at the extremes
		{ cosine: 0.999, label: "unsure" as const },
		{ cosine: 0.8, label: "unsure" as const },
	];
	await pairWorld(
		t,
		labelled.map((l) => ({ cosine: l.cosine })),
	);
	const labels: CalibrationLabel[] = labelled.map((l, p) => ({
		pairId: `p${String(p).padStart(2, "0")}a:p${String(p).padStart(2, "0")}b`,
		label: l.label,
		labelSource: p % 2 ? "owner" : "agent-draft",
	}));
	const module = createCluster(t.deps);
	const result = await module.applyCalibration(labels);
	expect(result).toEqual({
		clusterEdge: 0.9,
		clusterMerge: 0.925,
		clusterCap: 12,
		pairCandidate: 0.87,
		calibratedAt: T0,
	});
	expect(t.deps.store.read((db) => getThresholds(db))).toEqual(result);
	expect(t.deps.store.read((db) => getParam(db, "calibration"))).toMatchObject({
		labels: { same: 20, different: 7, unsure: 2, owner: 14, agentDraft: 15 },
	});
});

test("bad labels are refused", async () => {
	const t = setup();
	await pairWorld(t, [{ cosine: 0.9 }, { cosine: 0.8 }]);
	const module = createCluster(t.deps);
	const label = (
		pairId: string,
		l: CalibrationLabel["label"],
	): CalibrationLabel => ({
		pairId,
		label: l,
		labelSource: "owner",
	});
	// no `same` pair: the recall of nothing is undefined
	expect(() =>
		module.applyCalibration([label("p00a:p00b", "different")]),
	).toThrow("invalid_distill_request");
	expect(() => module.applyCalibration([])).toThrow("invalid_distill_request");
	expect(() => module.applyCalibration([label("nonsense", "same")])).toThrow(
		"invalid_distill_request",
	);
	expect(() => module.applyCalibration([label("p01b:p01a", "same")])).toThrow(
		"invalid_distill_request",
	);
	expect(() => module.applyCalibration([label("p00a:zzz", "same")])).toThrow(
		"invalid_distill_request",
	);
	// nothing was stored
	await t.deps.store.write(() => {});
	expect(t.deps.store.read((db) => getThresholds(db)).calibratedAt).toBeNull();
});

test("when no threshold is pure enough nothing merges; ties are at or above", () => {
	expect(
		fitThresholds([
			{ similarity: 0.95, same: true },
			{ similarity: 0.95, same: false },
			{ similarity: 0.9, same: true },
		]),
	).toMatchObject({ clusterEdge: 0.9, clusterMerge: 1 });
	// the last label alone is pure: merge is its similarity
	expect(
		fitThresholds([
			{ similarity: 0.97, same: true },
			{ similarity: 0.95, same: false },
			{ similarity: 0.9, same: false },
		]),
	).toMatchObject({
		clusterEdge: 0.97,
		clusterMerge: 0.97,
		pairCandidate: 0.94,
	});
});

test("a stage started after the labels sees the new thresholds", async () => {
	const t = setup();
	await pairWorld(t, [
		{ cosine: 0.99 },
		{ cosine: 0.97 },
		{ cosine: 0.95 },
		{ cosine: 0.8 },
	]);
	const module = createCluster(t.deps);
	module.registerHandlers();
	const thresholds = await module.applyCalibration([
		{ pairId: "p00a:p00b", label: "same", labelSource: "owner" },
		{ pairId: "p01a:p01b", label: "same", labelSource: "owner" },
		{ pairId: "p03a:p03b", label: "different", labelSource: "owner" },
	]);
	expect(thresholds).toMatchObject({ clusterEdge: 0.97, clusterMerge: 0.97 });
	expect(t.deps.store.read((db) => getThresholds(db))).toEqual(thresholds);
});

test("the neighbour search yields about every YIELD_WORK multiply-adds, however many rows", async () => {
	const dim = 512;
	const n = 400; // about 400 * 399 / 2 * 512 = 41M multiply-adds: at least one yield
	const vectors = Array.from({ length: n }, (_, i) => {
		const v = new Float32Array(dim);
		v[i % dim] = 1;
		v[(i * 7 + 3) % dim] = 0.5 + (v[(i * 7 + 3) % dim] ?? 0);
		return v;
	});
	let yields = 0;
	const gen = nearestNeighbors(vectors, 5, 0.1);
	let step = gen.next();
	let rows = 0;
	while (!step.done) {
		yields++;
		step = gen.next();
	}
	rows = step.value.length;
	expect(rows).toBe(n);
	const expected = Math.floor((((n * (n - 1)) / 2) * dim) / YIELD_WORK);
	expect(yields).toBeGreaterThanOrEqual(Math.max(1, expected - 1));
	// The yielding and the synchronous run give the same lists.
	expect(await runYielding(nearestNeighbors(vectors, 5, 0.1))).toEqual(
		runSync(nearestNeighbors(vectors, 5, 0.1)),
	);
});

test("the yielding sample is the synchronous sample", async () => {
	const t = setup();
	await pairWorld(t, bandedPairs(12));
	const sync = createCluster(t.deps).calibrationSample(30);
	const yielding = await sampleCalibrationYielding(
		(op) => t.deps.store.read(op),
		t.deps.spaceKey,
		30,
	);
	expect(yielding).toEqual(sync);
	await expect(
		sampleCalibrationYielding(
			(op) => t.deps.store.read(op),
			t.deps.spaceKey,
			0,
		),
	).rejects.toBeInstanceOf(DistillError);
});
