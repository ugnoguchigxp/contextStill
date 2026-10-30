import { afterEach, expect, test } from "bun:test";
import { waitFor } from "../../../infrastructure/wait-for";
import { upsertEpisode } from "../../experience";
import { getKnowledgeById } from "../../knowledge";
import type { ChatRequest } from "../../larm";
import { listClusterMembers, listClusters, setClusterState } from "../../map";
import { getVector, upsertVector } from "../../vectors";
import {
	DEFAULT_THRESHOLDS,
	type Generality,
	type Thresholds,
} from "../contracts";
import {
	createRun,
	getAssessment,
	getRun,
	setThresholds,
	upsertAssessment,
} from "../repository";
import { createAssess } from "../service/assess";
import { createCluster } from "../service/cluster";
import { atom, createTestDistill, seedAtoms, T0 } from "./fixtures";

const ts: ReturnType<typeof createTestDistill>[] = [];
afterEach(async () => {
	for (const t of ts.splice(0)) await t.dispose();
});
type T = ReturnType<typeof createTestDistill>;

const DIM = 8;
function arc(deg: number): Float32Array {
	const v = new Float32Array(DIM);
	const r = (deg * Math.PI) / 180;
	v[0] = Math.cos(r);
	v[1] = Math.sin(r);
	return v;
}

/** What the embedding step "computes": id -> vector. It embeds what has none for its text. */
function setup() {
	const embeddings = new Map<string, Float32Array>();
	const calls = { embed: 0 };
	const t: T = createTestDistill({
		embedKnowledge: async () => {
			calls.embed++;
			let embedded = 0;
			await t.deps.store.write((db) => {
				for (const [id, vector] of embeddings) {
					const row = getKnowledgeById(db, id);
					if (!row) continue;
					const stored = getVector(db, "knowledge", id, t.deps.spaceKey);
					if (stored?.contentDigest === row.contentDigest) continue;
					upsertVector(db, {
						ownerKind: "knowledge",
						ownerId: id,
						spaceKey: t.deps.spaceKey,
						contentDigest: row.contentDigest,
						vector,
						origin: "larm",
						verification: "verified",
						now: T0,
					});
					embedded++;
				}
			});
			return {
				owner: "knowledge",
				candidates: embedded,
				embedded,
				skipped: 0,
				failed: 0,
				busyWaits: 0,
			};
		},
	});
	ts.push(t);
	t.llm.fallback = (req: ChatRequest) => {
		const user = req.messages[1]!.content;
		const items = (
			JSON.parse(user.slice(user.indexOf("\n") + 1)) as {
				items: { ref: string; title: string }[];
			}
		).items;
		const verdict = (title: string): Generality =>
			title.includes("SPECIFIC") ? "repo_specific" : "general";
		return {
			schemaVersion: 1,
			items: items.map((i) => ({
				ref: i.ref,
				generality: verdict(i.title),
				reason: "r",
			})),
		};
	};
	const cluster = createCluster(t.deps);
	cluster.registerHandlers();
	createAssess(t.deps).registerHandlers();
	return { t, cluster, embeddings, calls };
}

/** Existing, assessed, embedded atoms; the same helper as the cluster tests use. */
async function existing(
	t: T,
	specs: { id: string; deg: number; over?: Parameters<typeof atom>[1] }[],
) {
	await seedAtoms(
		t.deps,
		specs.map((s) => atom(s.id, s.over)),
	);
	await t.deps.store.write((db) => {
		db.query(
			`INSERT OR IGNORE INTO vector_spaces
			   (space_key, model_id, revision, artifact_digest, dimension, descriptor_json, created_at)
			 VALUES (?, 'fixture', '1', 'x', ?, '{}', ?)`,
		).run(t.deps.spaceKey, DIM, T0);
		for (const s of specs) {
			const row = getKnowledgeById(db, s.id)!;
			upsertAssessment(db, {
				ownerKind: "knowledge",
				ownerId: s.id,
				generality: "general",
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
				ownerId: s.id,
				spaceKey: t.deps.spaceKey,
				contentDigest: row.contentDigest,
				vector: arc(s.deg),
				origin: "larm",
				verification: "verified",
				now: T0,
			});
		}
	});
}

async function runStage(
	t: T,
	module: { start: (...a: never[]) => unknown },
	stage: "cluster" | "incremental",
	opts: { dryRun?: boolean } = {},
) {
	const runId = `run_${Math.random().toString(36).slice(2)}`;
	await t.deps.store.write((db) =>
		createRun(db, { id: runId, stage, params: { ...opts }, at: T0 }),
	);
	const enqueued = await (
		module as unknown as {
			start: (s: string, r: string, o: object) => Promise<number>;
		}
	).start(stage, runId, { dryRun: false, ...opts });
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

const setT = (t: T, over: Partial<Thresholds>) =>
	t.deps.store.write((db) =>
		setThresholds(db, { ...DEFAULT_THRESHOLDS, ...over }, T0),
	);

const claims = (t: T) =>
	t.deps.store.read((db) =>
		listClusters(db, { kind: "claim" }).map((c) => ({
			...c,
			members: listClusterMembers(db, c.id)
				.map((m) => m.id)
				.sort(),
		})),
	);
const assessment = (t: T, id: string) =>
	t.deps.store.read((db) => getAssessment(db, "knowledge", id));

/** a1..a3 near 0 degrees (a cluster), b1 b2 near 90 (another), one far atom. */
async function base(t: T, cluster: ReturnType<typeof createCluster>) {
	await existing(t, [
		{ id: "a1", deg: 0 },
		{ id: "a2", deg: 2 },
		{ id: "a3", deg: 4 },
		{ id: "b1", deg: 90 },
		{ id: "b2", deg: 92 },
		{ id: "far", deg: 180 },
	]);
	await setT(t, { clusterEdge: 0.93, clusterMerge: 0.95, calibratedAt: T0 });
	const first = await runStage(t, cluster, "cluster");
	expect(first.run.counts.clusters).toBe(2);
	const c1 = claims(t).find((c) => c.members.includes("a1"))!;
	await t.deps.store.write((db) => setClusterState(db, c1.id, "distilled", T0));
	return c1;
}

test("new atoms are assessed, embedded and placed: one joins a cluster, one stays single, one is evidence", async () => {
	const { t, cluster, embeddings, calls } = setup();
	const c1 = await base(t, cluster);
	const b = claims(t).find((c) => c.members.includes("b1"))!;
	await seedAtoms(t.deps, [
		atom("n1", { title: "close to the first group" }),
		atom("n2", { title: "somewhere else" }),
		atom("n3", { title: "SPECIFIC to a repo" }),
	]);
	embeddings.set("n1", arc(3));
	embeddings.set("n2", arc(270));
	embeddings.set("n3", arc(1));

	const { enqueued, run } = await runStage(t, cluster, "incremental");
	expect(enqueued).toBe(1);
	expect(run.state).toBe("completed");
	expect(run.counts).toMatchObject({
		processed: 3,
		general: 2,
		repo_specific: 1,
		evidenceOnly: 1,
		placed: 1,
		singles: 1,
		embedded: 3,
		awaitingVector: 0,
	});
	// only the new atoms were sent to the model, once
	expect(t.llm.calls).toHaveLength(1);
	expect(t.llm.calls[0]!.messages[1]!.content).toContain("body n1");
	expect(t.llm.calls[0]!.messages[1]!.content).not.toContain("body a1");
	expect(calls.embed).toBe(1);

	const after = claims(t);
	const joined = after.find((c) => c.id === c1.id)!;
	expect(joined.members).toEqual(["a1", "a2", "a3", "n1"]);
	// distilled again from the next canonical stage, not a dead end
	expect(joined.state).toBe("pending");
	expect(joined.memberDigest).not.toBe(c1.memberDigest);
	expect(joined.revision).toBe(c1.revision + 1);
	expect(after.find((c) => c.id === b.id)).toMatchObject({
		state: "pending",
		memberDigest: b.memberDigest,
	});
	expect(after).toHaveLength(2);
	const member = t.deps.store
		.read((db) => listClusterMembers(db, c1.id))
		.find((m) => m.id === "n1")!;
	expect(member.similarity).toBeGreaterThan(0.99);

	expect(assessment(t, "n1")?.signals.placement).toBe("placed");
	expect(assessment(t, "n2")?.signals.placement).toBe("single");
	expect(assessment(t, "n3")?.signals.placement).toBeUndefined();
	expect(t.deps.store.read((db) => getKnowledgeById(db, "n3"))?.retrieval).toBe(
		"evidence_only",
	);
	expect(t.deps.store.read((db) => getKnowledgeById(db, "n2"))?.retrieval).toBe(
		"searchable",
	);

	// Nothing left to do: a second run enqueues nothing.
	const again = await runStage(t, cluster, "incremental");
	expect(again.enqueued).toBe(0);
	expect(t.llm.calls).toHaveLength(1);
});

test("an atom below the merge threshold, or a cluster at the cap, leaves the atom single", async () => {
	const { t, cluster, embeddings } = setup();
	const c1 = await base(t, cluster);
	await seedAtoms(t.deps, [atom("n1"), atom("n2")]);
	// 25 degrees away: the average link to the cluster is about 0.90 < 0.95
	embeddings.set("n1", arc(25));
	embeddings.set("n2", arc(3));
	const far = await runStage(t, cluster, "incremental");
	expect(far.run.counts).toMatchObject({ placed: 1, singles: 1 });
	expect(claims(t).find((c) => c.id === c1.id)!.members).toContain("n2");
	expect(claims(t).find((c) => c.id === c1.id)!.members).not.toContain("n1");

	// The cluster has 4 members now; with a cap of 4 it is full.
	await setT(t, { clusterEdge: 0.93, clusterMerge: 0.95, clusterCap: 4 });
	await seedAtoms(t.deps, [atom("n4")]);
	embeddings.set("n4", arc(2));
	const full = await runStage(t, cluster, "incremental");
	expect(full.run.counts).toMatchObject({ placed: 0, singles: 1 });
	expect(assessment(t, "n4")?.signals.placement).toBe("single");
});

test("a member whose text changed is assessed again and its distilled cluster goes pending", async () => {
	const { t, cluster, embeddings } = setup();
	const c1 = await base(t, cluster);
	await seedAtoms(t.deps, [atom("a2", { body: "body a2, edited" })]);
	embeddings.set("a2", arc(2));
	const { run } = await runStage(t, cluster, "incremental");
	expect(run.counts).toMatchObject({ processed: 1, regrouped: 1, placed: 0 });
	const after = claims(t).find((c) => c.id === c1.id)!;
	expect(after.state).toBe("pending");
	expect(after.memberDigest).not.toBe(c1.memberDigest);
	// not added a second time, not moved
	expect(after.members).toEqual(["a1", "a2", "a3"]);
	expect(assessment(t, "a2")?.signals.placement).toBe("regrouped");
	// the other cluster is untouched
	expect(claims(t).find((c) => c.members.includes("b1"))?.state).toBe(
		"pending",
	);
});

test("an atom without a usable vector waits, and is placed by the next run", async () => {
	const { t, cluster, embeddings } = setup();
	const c1 = await base(t, cluster);
	await seedAtoms(t.deps, [atom("n1")]);
	const waiting = await runStage(t, cluster, "incremental");
	expect(waiting.run.state).toBe("completed");
	expect(waiting.run.counts).toMatchObject({
		processed: 1,
		awaitingVector: 1,
		placed: 0,
	});
	expect(assessment(t, "n1")?.signals.placement).toBe("pending");
	expect(claims(t).find((c) => c.id === c1.id)!.state).toBe("distilled");

	// Nothing to assess, but a placement is pending: the stage runs it.
	embeddings.set("n1", arc(1));
	const next = await runStage(t, cluster, "incremental");
	expect(next.enqueued).toBe(1);
	expect(next.run.counts).toMatchObject({ placed: 1, embedded: 1 });
	expect(t.llm.calls).toHaveLength(1);
	expect(claims(t).find((c) => c.id === c1.id)!.members).toContain("n1");

	// A vector that is not verified is not used either.
	await seedAtoms(t.deps, [atom("n5")]);
	await t.deps.store.write((db) => {
		db.query(
			`INSERT OR REPLACE INTO vectors (owner_kind, owner_id, space_key, content_digest, vector, origin, verification, created_at, updated_at)
			 SELECT 'knowledge', 'n5', ?, content_digest, ?, 'legacy_import', 'unverified', ?, ? FROM knowledge_items WHERE id = 'n5'`,
		).run(t.deps.spaceKey, new Uint8Array(arc(1).buffer), T0, T0);
	});
	const unverified = await runStage(t, cluster, "incremental");
	expect(unverified.run.counts).toMatchObject({ awaitingVector: 1, placed: 0 });
});

test("a dry run counts the jobs and changes nothing", async () => {
	const { t, cluster } = setup();
	await existing(t, [{ id: "a1", deg: 0 }]);
	await seedAtoms(
		t.deps,
		Array.from({ length: 25 }, (_, i) =>
			atom(`n${String(i).padStart(2, "0")}`),
		),
	);
	const dry = await runStage(t, cluster, "incremental", { dryRun: true });
	expect(dry.enqueued).toBe(2);
	expect(t.llm.calls).toHaveLength(0);
	expect(t.deps.queue.stats().openJobs).toBe(0);
	expect(
		t.deps.store.read((db) => getAssessment(db, "knowledge", "n00")),
	).toBeNull();
});

test("only atoms are assessed by the incremental stage; episodes wait for the assess stage", async () => {
	const { t, cluster } = setup();
	await t.deps.store.write((db) =>
		upsertEpisode(db, {
			id: "e1",
			title: "an episode",
			situation: "s",
			intent: "",
			decision: "",
			observations: "",
			action: "a",
			outcome: "o",
			lesson: "l",
			openQuestions: [],
			outcomeKind: "success",
			eventStart: null,
			eventEnd: null,
			timePrecision: "unknown",
			confidence: 0.5,
			importance: 0.5,
			status: "active",
			space: "coding",
			scope: "global",
			repoKey: null,
			facets: {},
			metadata: {},
			createdAt: T0,
			updatedAt: T0,
		}),
	);
	const none = await runStage(t, cluster, "incremental");
	expect(none.enqueued).toBe(0);
	expect(t.llm.calls).toHaveLength(0);
});

test("an atom joins only a distilled cluster: pending, review, rejected and stale ones are left alone", async () => {
	for (const state of ["pending", "review", "rejected", "stale"] as const) {
		const { t, cluster, embeddings } = setup();
		const c1 = await base(t, cluster);
		await t.deps.store.write((db) => setClusterState(db, c1.id, state, T0));
		await seedAtoms(t.deps, [atom("n1")]);
		embeddings.set("n1", arc(3));
		const { run } = await runStage(t, cluster, "incremental");
		expect(run.counts).toMatchObject({ placed: 0, singles: 1 });
		const after = claims(t).find((c) => c.id === c1.id)!;
		expect(after.members).toEqual(["a1", "a2", "a3"]);
		expect(after.state).toBe(state);
		expect(after.memberDigest).toBe(c1.memberDigest);
		expect(assessment(t, "n1")?.signals.placement).toBe("single");
	}
});

test("a merge cluster of the conflict stage takes no atom", async () => {
	const { t, cluster, embeddings } = setup();
	const c1 = await base(t, cluster);
	await t.deps.store.write((db) =>
		db
			.query(
				"UPDATE map_clusters SET algorithm = 'conflict-merge-v1' WHERE id = ?",
			)
			.run(c1.id),
	);
	await seedAtoms(t.deps, [atom("n1")]);
	embeddings.set("n1", arc(3));
	const { run } = await runStage(t, cluster, "incremental");
	expect(run.counts).toMatchObject({ placed: 0, singles: 1 });
});

test("two atoms placed into one distilled cluster both end up in its member digest", async () => {
	const { t, cluster, embeddings } = setup();
	const c1 = await base(t, cluster);
	await seedAtoms(t.deps, [atom("n1"), atom("n2")]);
	embeddings.set("n1", arc(3));
	embeddings.set("n2", arc(1));
	const { run } = await runStage(t, cluster, "incremental");
	expect(run.counts).toMatchObject({ placed: 2 });
	const after = claims(t).find((c) => c.id === c1.id)!;
	expect(after.members).toEqual(["a1", "a2", "a3", "n1", "n2"]);
	expect(after.state).toBe("pending");
	const digests = t.deps.store.read((db) =>
		after.members.map((id) => getKnowledgeById(db, id)!.contentDigest),
	);
	expect(digests).toHaveLength(5);
});

test("a personal atom is not assessed and so never placed", async () => {
	const { t, cluster, embeddings } = setup();
	await base(t, cluster);
	await seedAtoms(t.deps, [atom("p1", { space: "personal" })]);
	embeddings.set("p1", arc(3));
	const { enqueued } = await runStage(t, cluster, "incremental");
	expect(enqueued).toBe(0);
	expect(assessment(t, "p1")).toBeNull();
	expect(t.llm.calls).toHaveLength(0);
});
