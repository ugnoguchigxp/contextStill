import { afterEach, expect, test } from "bun:test";
import { waitFor } from "../../../infrastructure/wait-for";
import { getKnowledgeById } from "../../knowledge";
import { listClusterMembers, listClusters, setClusterState } from "../../map";
import { upsertVector } from "../../vectors";
import {
	DEFAULT_THRESHOLDS,
	DistillError,
	type Generality,
	type Thresholds,
} from "../contracts";
import {
	createRun,
	getRun,
	setThresholds,
	upsertAssessment,
} from "../repository";
import { agglomerate, createCluster, loadPopulation } from "../service/cluster";
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

const DIM = 8;
/** A unit vector at `deg` degrees in the plane of dimensions (0, 1). */
function arc(deg: number, dim = DIM): Float32Array {
	const v = new Float32Array(dim);
	const r = (deg * Math.PI) / 180;
	v[0] = Math.cos(r);
	v[1] = Math.sin(r);
	return v;
}

interface Spec {
	id: string;
	vector: Float32Array | null;
	generality?: Generality | null;
	atom?: Parameters<typeof atom>[1];
	origin?: "larm" | "legacy_import";
	verification?: "verified" | "unverified";
}

/** Atoms with an assessment and a vector, inserted in the order given (so seq follows it). */
async function world(t: T, specs: Spec[], dim = DIM): Promise<void> {
	await seedAtoms(
		t.deps,
		specs.map((s) => atom(s.id, s.atom)),
	);
	await t.deps.store.write((db) => {
		db.query(
			`INSERT OR IGNORE INTO vector_spaces
			   (space_key, model_id, revision, artifact_digest, dimension, descriptor_json, created_at)
			 VALUES (?, 'fixture', '1', 'x', ?, '{}', ?)`,
		).run(t.deps.spaceKey, dim, T0);
		for (const s of specs) {
			const row = getKnowledgeById(db, s.id)!;
			if (s.generality !== null)
				upsertAssessment(db, {
					ownerKind: "knowledge",
					ownerId: s.id,
					generality: s.generality ?? "general",
					signals: {},
					reason: "",
					origin: "llm",
					contentDigest: row.contentDigest,
					promptVersion: "assess.v1",
					callId: null,
					at: T0,
				});
			if (s.vector)
				upsertVector(db, {
					ownerKind: "knowledge",
					ownerId: s.id,
					spaceKey: t.deps.spaceKey,
					contentDigest: row.contentDigest,
					vector: s.vector,
					origin: s.origin ?? "larm",
					verification: s.verification ?? "verified",
					now: T0,
				});
		}
	});
}

const setT = (t: T, over: Partial<Thresholds>) =>
	t.deps.store.write((db) =>
		setThresholds(db, { ...DEFAULT_THRESHOLDS, ...over }, T0),
	);

async function runCluster(
	t: T,
	module: ReturnType<typeof createCluster>,
	opts: { dryRun?: boolean; allowUnverified?: boolean; limit?: number } = {},
) {
	const runId = `run_${Math.random().toString(36).slice(2)}`;
	await t.deps.store.write((db) =>
		createRun(db, { id: runId, stage: "cluster", params: { ...opts }, at: T0 }),
	);
	const enqueued = await module.start("cluster", runId, {
		dryRun: false,
		...opts,
	});
	if (enqueued > 0 && !opts.dryRun)
		await waitFor(
			async () => {
				await t.deps.queue.tick();
				return (
					t.deps.store.read((db) => getRun(db, runId))!.state !== "running"
				);
			},
			{ timeout: 10_000 },
		);
	return { enqueued, run: t.deps.store.read((db) => getRun(db, runId))! };
}

const claims = (t: T) =>
	t.deps.store.read((db) =>
		listClusters(db, { kind: "claim" }).map((c) => ({
			...c,
			members: listClusterMembers(db, c.id),
		})),
	);
const memberIds = (c: { members: { id: string }[] }) =>
	c.members.map((m) => m.id).sort();

/** The connected components of the candidate edges: what single linkage would make. */
function components(vectors: Float32Array[], edge: number): number {
	const parent = vectors.map((_, i) => i);
	const find = (x: number): number =>
		parent[x] === x ? x : (parent[x] = find(parent[x]!));
	for (let i = 0; i < vectors.length; i++)
		for (let j = i + 1; j < vectors.length; j++) {
			let dot = 0;
			for (let d = 0; d < vectors[i]!.length; d++)
				dot += vectors[i]![d]! * vectors[j]![d]!;
			if (dot >= edge) parent[find(i)] = find(j);
		}
	return new Set(vectors.map((_, i) => find(i))).size;
}

test("average link does not chain: the cap is 12 and the threshold splits a chain", () => {
	// 30 points 3 degrees apart. Every point is a candidate neighbour of the ones within 7 steps,
	// so single linkage makes one cluster of 30.
	const vectors = Array.from({ length: 30 }, (_, i) => arc(i * 3));
	const seqs = vectors.map((_, i) => i + 1);
	const edges: [number, number][] = [];
	for (let i = 0; i < 30; i++)
		for (let j = i + 1; j < 30; j++) if (j - i <= 7) edges.push([i, j]);
	expect(components(vectors, 0.93)).toBe(1);

	const capped = agglomerate({ vectors, seqs, edges, merge: 0.9, cap: 12 });
	expect(Math.max(...capped.map((c) => c.length))).toBeGreaterThanOrEqual(8);
	expect(capped.length).toBeGreaterThanOrEqual(3);
	expect(capped.every((c) => c.length <= 12)).toBe(true);
	expect(capped.flat().sort((a, b) => a - b)).toEqual(
		Array.from({ length: 30 }, (_, i) => i),
	);

	// 8 degrees apart: neighbours are 2 steps away, a group of 5 averages 0.952 < 0.96.
	const wide = Array.from({ length: 30 }, (_, i) => arc(i * 8));
	const wideEdges: [number, number][] = [];
	for (let i = 0; i < 30; i++)
		for (let j = i + 1; j <= Math.min(29, i + 2); j++) wideEdges.push([i, j]);
	expect(components(wide, 0.93)).toBeLessThan(30);
	const tight = agglomerate({
		vectors: wide,
		seqs,
		edges: wideEdges,
		merge: 0.96,
		cap: 12,
	});
	expect(tight.length).toBeGreaterThanOrEqual(7);
	expect(Math.max(...tight.map((c) => c.length))).toBeLessThanOrEqual(4);
	const loose = agglomerate({
		vectors: wide,
		seqs,
		edges: wideEdges,
		merge: 0.8,
		cap: 12,
	});
	expect(Math.max(...loose.map((c) => c.length))).toBeGreaterThan(4);
});

test("a tie goes to the pair with the lower minimum seq", () => {
	// q (index 2) is exactly between p and r: both pairs have the same average link.
	const p = arc(-10);
	const q = arc(0);
	const r = arc(10);
	const edges: [number, number][] = [
		[0, 2],
		[1, 2],
	];
	// p has seq 1, r has seq 2, q has seq 3: the pair (p, q) goes first.
	expect(
		agglomerate({
			vectors: [p, r, q],
			seqs: [1, 2, 3],
			edges,
			merge: 0.9,
			cap: 2,
		}),
	).toEqual([[0, 2]]);
	// r first: the pair (q, r).
	expect(
		agglomerate({
			vectors: [p, r, q],
			seqs: [2, 1, 3],
			edges,
			merge: 0.9,
			cap: 2,
		}),
	).toEqual([[1, 2]]);
});

test("the pair that does not fit the cap is skipped, the next one is merged", () => {
	// Three points, all similar; cap 2: the best pair merges and the third stays alone.
	const vectors = [arc(0), arc(2), arc(10)];
	const edges: [number, number][] = [
		[0, 1],
		[0, 2],
		[1, 2],
	];
	expect(
		agglomerate({ vectors, seqs: [1, 2, 3], edges, merge: 0.9, cap: 2 }),
	).toEqual([[0, 1]]);
});

test("the cluster stage groups the population and ignores the rest", async () => {
	const t = setup();
	await world(t, [
		{ id: "a1", vector: arc(0) },
		{ id: "a2", vector: arc(2) },
		{ id: "a3", vector: arc(4) },
		{ id: "b1", vector: arc(90) },
		{ id: "b2", vector: arc(92) },
		{ id: "lone", vector: arc(180) },
		// not in the population:
		{ id: "x-spec", vector: arc(1), generality: "repo_specific" },
		{ id: "x-none", vector: arc(1), generality: null },
		{ id: "x-old", vector: arc(1), atom: { status: "superseded" } },
		{ id: "x-ev", vector: arc(3) },
	]);
	await t.deps.store.write((db) =>
		db
			.query(
				"UPDATE knowledge_items SET retrieval = 'evidence_only' WHERE id = 'x-ev'",
			)
			.run(),
	);
	await setT(t, { clusterEdge: 0.93, clusterMerge: 0.95 });
	const module = createCluster(t.deps);
	module.registerHandlers();
	const { run } = await runCluster(t, module);
	expect(run.state).toBe("completed");
	expect(run.counts).toMatchObject({
		population: 6,
		usable: 6,
		clusters: 2,
		clustered: 5,
		singles: 1,
		inserted: 2,
	});
	const rows = claims(t);
	expect(rows.map(memberIds).sort()).toEqual([
		["a1", "a2", "a3"],
		["b1", "b2"],
	]);
	for (const c of rows) {
		expect(c).toMatchObject({
			state: "pending",
			parentId: null,
			level: 0,
			algorithm: "avglink.v1|t=0.950|cap=12|e=0.930",
		});
		expect(c.id).toMatch(/^cl_[0-9a-f]{24}$/);
		for (const m of c.members) {
			expect(m.role).toBe("member");
			expect(m.similarity).toBeGreaterThan(0.99);
		}
	}
	// The middle member is the closest to the centroid.
	const a = rows.find((c) => memberIds(c).includes("a1"))!;
	const sim = (id: string) => a.members.find((m) => m.id === id)!.similarity!;
	expect(sim("a2")).toBeGreaterThan(sim("a1"));
});

test("a rerun changes nothing; a changed composition makes a new cluster and the old one stale", async () => {
	const t = setup();
	await world(t, [
		{ id: "a1", vector: arc(0) },
		{ id: "a2", vector: arc(2) },
		{ id: "b1", vector: arc(90) },
		{ id: "b2", vector: arc(92) },
	]);
	await setT(t, { clusterEdge: 0.93, clusterMerge: 0.95 });
	const module = createCluster(t.deps);
	module.registerHandlers();
	await runCluster(t, module);
	const dump = () =>
		t.deps.store.read((db) => ({
			clusters: db.query("SELECT * FROM map_clusters ORDER BY id").all(),
			members: db
				.query(
					"SELECT * FROM map_cluster_members ORDER BY cluster_id, member_id",
				)
				.all(),
		}));
	const before = dump();
	expect(before.clusters).toHaveLength(2);

	t.setNow("2026-10-31T00:00:00.000Z");
	const again = await runCluster(t, module);
	expect(again.run.counts).toMatchObject({
		clusters: 2,
		unchanged: 2,
		inserted: 0,
		updated: 0,
		staled: 0,
	});
	expect(dump()).toEqual(before);

	// A cluster that was distilled keeps its state when it comes out the same.
	const a = claims(t).find((c) => memberIds(c).includes("a1"))!;
	await t.deps.store.write((db) => setClusterState(db, a.id, "distilled", T0));
	await runCluster(t, module);
	expect(claims(t).find((c) => c.id === a.id)?.state).toBe("distilled");

	// a3 joins the first group: its cluster has a new composition, the old one goes stale.
	await world(t, [{ id: "a3", vector: arc(4) }]);
	const grown = await runCluster(t, module);
	expect(grown.run.counts).toMatchObject({
		inserted: 1,
		unchanged: 1,
		staled: 1,
	});
	const rows = claims(t);
	expect(rows).toHaveLength(3);
	expect(rows.find((c) => c.id === a.id)?.state).toBe("stale");
	const fresh = rows.find((c) => memberIds(c).join() === "a1,a2,a3")!;
	expect(fresh).toMatchObject({ state: "pending" });
	expect(fresh.id).not.toBe(a.id);

	// Back to the old composition: the old cluster is current again.
	await t.deps.store.write((db) =>
		db
			.query("UPDATE knowledge_items SET status = 'superseded' WHERE id = 'a3'")
			.run(),
	);
	const back = await runCluster(t, module);
	expect(back.run.counts).toMatchObject({ staled: 1, revived: 1 });
	expect(claims(t).find((c) => c.id === a.id)?.state).toBe("pending");
	expect(claims(t).find((c) => c.id === fresh.id)?.state).toBe("stale");
});

test("a cluster whose members were all absorbed is left alone", async () => {
	const t = setup();
	await world(t, [
		{ id: "a1", vector: arc(0) },
		{ id: "a2", vector: arc(2) },
		{ id: "b1", vector: arc(90) },
		{ id: "b2", vector: arc(92) },
	]);
	await setT(t, { clusterEdge: 0.93, clusterMerge: 0.95 });
	const module = createCluster(t.deps);
	module.registerHandlers();
	await runCluster(t, module);
	const a = claims(t).find((c) => memberIds(c).includes("a1"))!;
	await t.deps.store.write((db) => {
		setClusterState(db, a.id, "distilled", T0);
		db.query(
			"UPDATE knowledge_items SET status = 'superseded' WHERE id IN ('a1','a2')",
		).run();
	});
	const again = await runCluster(t, module);
	expect(again.run.counts).toMatchObject({
		population: 2,
		clusters: 1,
		staled: 0,
	});
	expect(claims(t).find((c) => c.id === a.id)?.state).toBe("distilled");
});

test("unverified vectors stop the stage unless the pilot allows them", async () => {
	const t = setup();
	await world(t, [
		{
			id: "a1",
			vector: arc(0),
			origin: "legacy_import",
			verification: "unverified",
		},
		{
			id: "a2",
			vector: arc(2),
			origin: "legacy_import",
			verification: "unverified",
		},
	]);
	await setT(t, { clusterEdge: 0.93, clusterMerge: 0.95 });
	const module = createCluster(t.deps);
	module.registerHandlers();
	await expect(
		module.start("cluster", "run_x", { dryRun: false }),
	).rejects.toMatchObject({
		code: "distill_vectors_unverified",
	});
	await expect(
		module.start("cluster", "run_x", { dryRun: true }),
	).rejects.toBeInstanceOf(DistillError);
	const pilot = await runCluster(t, module, { allowUnverified: true });
	expect(pilot.run.state).toBe("completed");
	expect(claims(t)[0]!.algorithm).toBe(
		"avglink.v1|t=0.950|cap=12|e=0.930|unverified",
	);
});

test("1% of the population may lack a usable vector, more may not", async () => {
	const t = setup();
	const specs: Spec[] = Array.from({ length: 100 }, (_, i) => ({
		id: `k${String(i).padStart(3, "0")}`,
		vector: arc((i % 10) * 1),
	}));
	specs[0] = { id: "k000", vector: null };
	await world(t, specs);
	const module = createCluster(t.deps);
	await expect(module.start("cluster", "r", { dryRun: true })).resolves.toBe(1);
	// A vector made from another text counts as missing.
	await t.deps.store.write((db) =>
		db
			.query(
				"UPDATE vectors SET content_digest = 'old' WHERE owner_id = 'k001'",
			)
			.run(),
	);
	await expect(
		module.start("cluster", "r", { dryRun: true }),
	).rejects.toMatchObject({
		code: "distill_vectors_unverified",
	});
	// the pilot flag does not apply the 1% rule
	await expect(
		module.start("cluster", "r", { dryRun: true, allowUnverified: true }),
	).resolves.toBe(1);
});

test("a dry run enqueues nothing; fewer than two usable atoms is nothing to do", async () => {
	const t = setup();
	await world(t, [{ id: "a1", vector: arc(0) }]);
	const module = createCluster(t.deps);
	module.registerHandlers();
	await expect(module.start("cluster", "r", { dryRun: false })).resolves.toBe(
		0,
	);
	await world(t, [{ id: "a2", vector: arc(1) }]);
	await expect(module.start("cluster", "r", { dryRun: true })).resolves.toBe(1);
	expect(t.deps.queue.stats().openJobs).toBe(0);
	// the default thresholds apply when nothing was calibrated
	const { run } = await runCluster(t, module);
	expect(run.counts.clusters).toBe(1);
});

test("atoms of the personal space are not in the population, whatever their assessment", async () => {
	const t = setup();
	await world(t, [
		{ id: "a1", vector: arc(0) },
		{ id: "a2", vector: arc(1) },
		{ id: "a3", vector: arc(2) },
		{ id: "p1", vector: arc(1), atom: { space: "personal" } },
	]);
	await setT(t, { clusterEdge: 0.93, clusterMerge: 0.95, calibratedAt: T0 });
	const module = createCluster(t.deps);
	module.registerHandlers();
	const { run } = await runCluster(t, module);
	expect(run.state).toBe("completed");
	const all = claims(t);
	expect(all).toHaveLength(1);
	expect(all[0]!.members.map((m) => m.id).sort()).toEqual(["a1", "a2", "a3"]);
	expect(
		t.deps.store.read((db) => loadPopulation(db, t.deps.spaceKey)).atoms,
	).toHaveLength(3);
});
