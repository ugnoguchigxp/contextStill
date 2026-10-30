import { afterEach, expect, test } from "bun:test";
import {
	getKnowledgeById,
	replaceKnowledgeEvidence,
	setKnowledgeDisposition,
} from "../../knowledge";
import { LarmError } from "../../larm";
import { edgesFrom, getCluster, setClusterState } from "../../map";
import { DistillError } from "../contracts";
import {
	getPairJudgment,
	getRun,
	listReviews,
	upsertPairJudgment,
} from "../repository";
import { mergeClusterId, openPairReview } from "../service/conflict/apply";
import {
	scanCandidates,
	scanCandidatesYielding,
	unjudgedCandidates,
} from "../service/conflict/candidates";
import { enqueueResolveJob, RESOLVE_KIND } from "../service/conflict/handlers";
import { classify } from "../service/conflict/handlers";
import { createConflict } from "../service/conflict";
import {
	decideConflict,
	gatherStrength,
	STRENGTH,
} from "../service/conflict/strength";
import {
	canonical,
	drain,
	isJudgePrompt,
	isVerifyPrompt,
	newRun,
	SPACE_KEY,
	unit,
	world,
	type World,
} from "../service/conflict/support.test";
import { messageText, T0 } from "./fixtures";

const worlds: World[] = [];
afterEach(async () => {
	for (const w of worlds.splice(0)) await w.dispose();
});
async function setup() {
	const w = await world();
	worlds.push(w);
	const conflict = createConflict(w.deps);
	conflict.registerHandlers();
	return { w, conflict, deps: w.deps };
}

/** A judge reply that gives every pair of the batch the same verdict. */
const verdictFor =
	(verdict: string, aNot: string[] = [], bNot: string[] = []) =>
	(req: Parameters<typeof messageText>[0]) => {
		const n = (messageText(req).match(/### Pair \d+/g) ?? []).length;
		return {
			schemaVersion: 1,
			pairs: Array.from({ length: n }, (_, index) => ({
				index,
				verdict,
				aNotAppliesWhen: aNot,
				bNotAppliesWhen: bNot,
				note: `note ${index}`,
			})),
		};
	};
/** A judge reply with a verdict chosen per pair ("c1|c2" names the pair by its titles). */
const byPair =
	(spec: Record<string, string>) =>
	(req: Parameters<typeof messageText>[0]) => ({
		schemaVersion: 1,
		pairs: messageText(req)
			.split("### Pair ")
			.slice(1)
			.map((block, index) => {
				const key = Object.keys(spec).find((k) =>
					k.split("|").every((id) => block.includes(`title ${id}\n`)),
				);
				return {
					index,
					verdict: key ? spec[key] : "unrelated",
					aNotAppliesWhen: spec[key ?? ""] === "compatible" ? ["ignored"] : [],
					bNotAppliesWhen: spec[key ?? ""] === "compatible" ? ["ignored"] : [],
					note: "",
				};
			}),
	});
const similar = [unit(1, 0, 0), unit(0.99, 0.1, 0)] as const;

test("candidates: neighbours above the threshold and canonicals of one claim cluster", async () => {
	const { deps } = await setup();
	await canonical(deps, { id: "A", vec: unit(1, 0, 0) });
	await canonical(deps, { id: "B", vec: unit(0.99, 0.1, 0) });
	await canonical(deps, { id: "C", vec: unit(0, 1, 0) });
	await canonical(deps, { id: "D", vec: unit(0, 0, 1), clusterId: "cl1" });
	await canonical(deps, { id: "E", vec: unit(0, 0.6, 0.8), clusterId: "cl1" });
	await canonical(deps, { id: "F", vec: null });
	const scan = deps.store.read((db) => scanCandidates(db, SPACE_KEY));
	expect(scan.pairs.map((p) => [p.a, p.b, p.reason])).toEqual([
		["A", "B", "neighbour"],
		["D", "E", "cluster"],
	]);
	expect(scan.pairs[0]!.similarity).toBeCloseTo(
		0.99 / Math.hypot(0.99, 0.1),
		5,
	);
	expect(scan.pairs[1]!.similarity).toBeCloseTo(0.8, 5);
	expect(scan.withoutVector).toEqual(["F"]);
	// a higher bar removes the neighbour pair but not the cluster pair
	const strict = deps.store.read((db) => scanCandidates(db, SPACE_KEY, 0.999));
	expect(strict.pairs.map((p) => [p.a, p.b])).toEqual([["D", "E"]]);
});

test("a judgment of the current texts removes a pair from the candidates; other digests do not", async () => {
	const { deps } = await setup();
	await canonical(deps, { id: "A", vec: similar[0] });
	await canonical(deps, { id: "B", vec: similar[1] });
	const pair = deps.store.read((db) => scanCandidates(db, SPACE_KEY).pairs[0]!);
	const judge = (aDigest: string, bDigest: string) =>
		deps.store.write((db) =>
			upsertPairJudgment(db, {
				aId: "A",
				bId: "B",
				aDigest,
				bDigest,
				verdict: "compatible",
				resolution: "none",
				detail: {},
				callId: null,
				at: T0,
			}),
		);
	await judge("old", pair.bDigest);
	expect(
		deps.store.read((db) => unjudgedCandidates(db, SPACE_KEY)),
	).toHaveLength(1);
	await judge(pair.aDigest, pair.bDigest);
	expect(
		deps.store.read((db) => unjudgedCandidates(db, SPACE_KEY)),
	).toHaveLength(0);
});

test("start: 8 pairs per job, limit, dry run, and the run keeps the job count", async () => {
	const { deps, conflict } = await setup();
	for (let i = 0; i < 10; i++)
		await canonical(deps, {
			id: `K${i}`,
			vec: unit(Math.cos(i), Math.sin(i), 0),
			clusterId: "big",
		});
	await newRun(deps, "r1");
	// 45 pairs: 6 jobs; with a limit of 9 pairs: 2 jobs
	expect(await conflict.start("conflict", "r1", { dryRun: true })).toBe(6);
	expect(deps.queue.stats().openJobs).toBe(0);
	expect(
		await conflict.start("conflict", "r1", { dryRun: false, limit: 9 }),
	).toBe(2);
	expect(deps.queue.stats().openJobs).toBe(2);
	expect(deps.store.read((db) => getRun(db, "r1"))!.counts).toEqual({
		jobs: 2,
		fed: 2,
		planned: 2,
	});
	// the same run and the same pairs are the same jobs
	expect(
		await conflict.start("conflict", "r1", { dryRun: false, limit: 9 }),
	).toBe(0);
	await expect(
		conflict.start("assess", "r1", { dryRun: true }),
	).rejects.toBeInstanceOf(DistillError);
});

test("duplicate: a pending merge cluster of the union of the atoms; the canonical stage then supersedes the old two", async () => {
	const { w, deps, conflict } = await setup();
	await canonical(deps, { id: "c1", vec: similar[0], atoms: 2 });
	await canonical(deps, { id: "c2", vec: similar[1], atoms: 2 });
	w.llm.when(isJudgePrompt, verdictFor("duplicate"));
	await newRun(deps, "r1");
	expect(await conflict.start("conflict", "r1", { dryRun: false })).toBe(1);
	await drain(deps);

	const j = deps.store.read((db) => getPairJudgment(db, "c1", "c2"))!;
	expect(j.verdict).toBe("duplicate");
	expect(j.resolution).toBe("none");
	const clusterId = mergeClusterId("c1", "c2");
	const cluster = deps.store.read((db) => getCluster(db, clusterId))!;
	expect(cluster).toMatchObject({
		kind: "claim",
		state: "pending",
		algorithm: "conflict-merge-v1",
	});
	const run = deps.store.read((db) => getRun(db, "r1"))!;
	expect(run.state).toBe("completed");
	expect(run.counts).toMatchObject({
		jobs: 2,
		jobsSettled: 2,
		pairsJudged: 1,
		duplicate: 1,
		mergeClusters: 1,
	});

	// the members are the four atoms
	const members = deps.store.read((db) =>
		db
			.query(
				"SELECT member_id FROM map_cluster_members WHERE cluster_id = ? ORDER BY member_id",
			)
			.all(clusterId),
	) as { member_id: string }[];
	expect(members.map((m) => m.member_id)).toEqual([
		"c1-a1",
		"c1-a2",
		"c2-a1",
		"c2-a2",
	]);

	// nothing to do while the canonical stage has not run
	await newRun(deps, "r2");
	expect(await conflict.start("conflict", "r2", { dryRun: false })).toBe(0);
	expect(deps.store.read((db) => getKnowledgeById(db, "c1"))!.status).toBe(
		"active",
	);

	// the canonical stage distilled the cluster into a new canonical n1
	await canonical(deps, { id: "n1", vec: null, clusterId, atoms: 0 });
	await deps.store.write((db) =>
		setClusterState(db, clusterId, "distilled", T0),
	);
	await newRun(deps, "r3");
	await conflict.start("conflict", "r3", { dryRun: false });
	const after = deps.store.read((db) => ({
		c1: getKnowledgeById(db, "c1")!,
		c2: getKnowledgeById(db, "c2")!,
		edges: edgesFrom(db, "knowledge", "n1", "supersedes")
			.map((e) => e.dst.id)
			.sort(),
		j: getPairJudgment(db, "c1", "c2")!,
	}));
	expect(after.c1).toMatchObject({
		status: "superseded",
		retrieval: "evidence_only",
	});
	expect(after.c2.status).toBe("superseded");
	expect(after.edges).toEqual(["c1", "c2"]);
	expect(after.j.resolution).toBe("merged");
});

test("duplicate: when the new canonical keeps the id of one of the old two, only the other is superseded; a cluster in review hands the pair to the owner", async () => {
	const { w, deps, conflict } = await setup();
	await canonical(deps, { id: "c1", vec: similar[0] });
	await canonical(deps, { id: "c2", vec: similar[1] });
	w.llm.when(isJudgePrompt, verdictFor("duplicate"));
	await newRun(deps, "r1");
	await conflict.start("conflict", "r1", { dryRun: false });
	await drain(deps);
	const clusterId = mergeClusterId("c1", "c2");
	// c1 was rewritten in place by the canonical stage
	await deps.store.write((db) => {
		db.query(
			"UPDATE knowledge_items SET metadata_json = ? WHERE id = 'c1'",
		).run(JSON.stringify({ distill: { clusterId } }));
		setClusterState(db, clusterId, "distilled", T0);
	});
	await newRun(deps, "r2");
	await conflict.start("conflict", "r2", { dryRun: false });
	const rows = deps.store.read((db) => [
		getKnowledgeById(db, "c1")!.status,
		getKnowledgeById(db, "c2")!.status,
	]);
	expect(rows).toEqual(["active", "superseded"]);

	// another pair whose merge cluster went to review
	await canonical(deps, { id: "d1", vec: unit(0, 0, 1) });
	await canonical(deps, { id: "d2", vec: unit(0, 0.05, 1) });
	await newRun(deps, "r3");
	await conflict.start("conflict", "r3", { dryRun: false });
	await drain(deps);
	await deps.store.write((db) =>
		setClusterState(db, mergeClusterId("d1", "d2"), "review", T0),
	);
	await newRun(deps, "r4");
	await conflict.start("conflict", "r4", { dryRun: false });
	expect(
		deps.store.read((db) => getPairJudgment(db, "d1", "d2"))!.resolution,
	).toBe("owner_pending");
});

test("condition_split: the conditions are added after the verifier agrees; the digest and the vector stay", async () => {
	const { w, deps, conflict } = await setup();
	await canonical(deps, { id: "c1", vec: similar[0] });
	await canonical(deps, { id: "c2", vec: similar[1] });
	const before = deps.store.read((db) => getKnowledgeById(db, "c1")!);
	w.llm.when(
		isJudgePrompt,
		verdictFor("condition_split", ["situation c2 body"], ["situation c1 body"]),
	);
	w.llm.when(isVerifyPrompt, {
		schemaVersion: 1,
		verdict: "supported",
		rationale: "ok",
	});
	await newRun(deps, "r1");
	await conflict.start("conflict", "r1", { dryRun: false });
	await drain(deps);
	const a = deps.store.read((db) => getKnowledgeById(db, "c1")!);
	const b = deps.store.read((db) => getKnowledgeById(db, "c2")!);
	expect(a.notAppliesWhen).toEqual(["situation c2 body"]);
	expect(b.notAppliesWhen).toEqual(["situation c1 body"]);
	expect(a.revision).toBe(before.revision + 1);
	expect(a.contentDigest).toBe(before.contentDigest);
	expect(a.status).toBe("active");
	expect(
		deps.store.read((db) => getPairJudgment(db, "c1", "c2"))!,
	).toMatchObject({ verdict: "condition_split", resolution: "split" });
	expect(w.llm.calls.filter(isVerifyPrompt)).toHaveLength(2);
	expect(deps.store.read((db) => getRun(db, "r1"))!.state).toBe("completed");
});

test("condition_split: a verifier that does not agree sends the draft to the owner and changes nothing", async () => {
	const { w, deps, conflict } = await setup();
	await canonical(deps, { id: "c1", vec: similar[0] });
	await canonical(deps, { id: "c2", vec: similar[1] });
	w.llm.when(
		isJudgePrompt,
		verdictFor("condition_split", ["situation c2 body"], ["situation c1 body"]),
	);
	w.llm.when(
		isVerifyPrompt,
		{ schemaVersion: 1, verdict: "supported", rationale: "" },
		{ schemaVersion: 1, verdict: "rejected", rationale: "contradicts" },
	);
	await newRun(deps, "r1");
	await conflict.start("conflict", "r1", { dryRun: false });
	await drain(deps);
	expect(
		deps.store.read((db) => getKnowledgeById(db, "c1")!.notAppliesWhen),
	).toEqual([]);
	expect(
		deps.store.read((db) => getKnowledgeById(db, "c2")!.notAppliesWhen),
	).toEqual([]);
	const reviews = deps.store.read((db) => listReviews(db, "open"));
	expect(reviews).toHaveLength(1);
	expect(reviews[0]).toMatchObject({
		kind: "verifier_unknown",
		subject: { type: "pair", a: "c1", b: "c2" },
		proposal: {
			aNotAppliesWhen: ["situation c2 body"],
			bNotAppliesWhen: ["situation c1 body"],
			verifier: { a: "supported", b: "rejected" },
		},
	});
	expect(
		deps.store.read((db) => getPairJudgment(db, "c1", "c2"))!.resolution,
	).toBe("owner_pending");
});

test("strength by hand: log2(1+atoms) + log2(1+records) + 0.5 log2(1+used) + recency", async () => {
	const { deps } = await setup();
	await canonical(deps, {
		id: "s",
		vec: null,
		atoms: 3,
		records: 1,
		used: 3,
		atomCreatedAt: "2026-10-01T00:00:00.000Z",
	});
	await canonical(deps, {
		id: "w",
		vec: null,
		atoms: 1,
		records: 1,
		used: 0,
		atomCreatedAt: "2026-06-01T00:00:00.000Z",
	});
	await canonical(deps, {
		id: "m",
		vec: null,
		atoms: 3,
		records: 5,
		sourceMissing: true,
	});
	const [s, w, m] = deps.store.read((db) =>
		["s", "w", "m"].map((id) => gatherStrength(db, id)),
	);
	expect(s).toMatchObject({
		atoms: 3,
		records: 3,
		used: 3,
		latest: "2026-10-01T00:00:00.000Z",
	});
	expect(w).toMatchObject({ atoms: 1, records: 1, used: 0 });
	// source_missing atoms count as atoms but add no raw records
	expect(m).toMatchObject({ atoms: 3, records: 0 });
	const d = decideConflict(s!, w!);
	// s: 2 + 2 + 0.5*2 + 1 (122 days newer) = 6;  w: 1 + 1 + 0 + 0 = 2
	expect(d.a.score).toBeCloseTo(6, 9);
	expect(d.a.recency).toBe(1);
	expect(d.b.score).toBeCloseTo(2, 9);
	expect(d.winner).toBe("a");
	expect(decideConflict(w!, s!).winner).toBe("b");
	// exactly 89 days newer earns nothing
	const near = { ...s!, latest: "2026-08-29T00:00:00.000Z" };
	expect(decideConflict(near, w!).a.recency).toBe(0);
	expect(STRENGTH.minGap).toBe(1);
});

test("strength: a gap below 1.0, or an importance of 0.8, leaves the decision to the owner", () => {
	const base = { atoms: 3, records: 3, used: 0, latest: null, importance: 0.5 };
	// 2 + 2 = 4 against 1.585 + 1.585 = 3.17: gap 0.83
	expect(decideConflict(base, { ...base, atoms: 2, records: 2 })).toMatchObject(
		{ winner: null, reason: "close" },
	);
	// a gap of exactly 1.0 (3 atoms, 3 records against 1 atom, 3 records) is automatic
	expect(decideConflict(base, { ...base, atoms: 1 }).winner).toBe("a");
	expect(
		decideConflict(
			{ ...base, atoms: 15, records: 15, importance: 0.8 },
			{ ...base, atoms: 1, records: 1 },
		),
	).toMatchObject({ winner: null, reason: "importance" });
});

test("conflict: the weaker side is retracted, contradicts is recorded, the orphan atoms go with it", async () => {
	const { w, deps, conflict } = await setup();
	await canonical(deps, {
		id: "c1",
		vec: similar[0],
		atoms: 3,
		records: 1,
		used: 3,
	});
	await canonical(deps, { id: "c2", vec: similar[1], atoms: 1, records: 1 });
	w.llm.when(isJudgePrompt, verdictFor("conflict"));
	await newRun(deps, "r1");
	await conflict.start("conflict", "r1", { dryRun: false });
	await drain(deps);
	const loser = deps.store.read((db) => getKnowledgeById(db, "c2")!);
	expect(loser).toMatchObject({
		status: "retracted",
		retrieval: "evidence_only",
	});
	expect(deps.store.read((db) => getKnowledgeById(db, "c1")!.status)).toBe(
		"active",
	);
	const edge = deps.store.read((db) =>
		edgesFrom(db, "knowledge", "c1", "contradicts"),
	);
	expect(edge).toHaveLength(1);
	expect(edge[0]).toMatchObject({
		dst: { kind: "knowledge", id: "c2" },
		origin: "llm",
		status: "active",
	});
	expect(
		deps.store.read((db) => getPairJudgment(db, "c1", "c2"))!.resolution,
	).toBe("a_wins");
	expect(deps.store.read((db) => getKnowledgeById(db, "c2-a1")!.status)).toBe(
		"retracted",
	);
	expect(deps.store.read((db) => getKnowledgeById(db, "c1-a1")!.status)).toBe(
		"superseded",
	);
	expect(deps.store.read((db) => getRun(db, "r1"))!.counts).toMatchObject({
		conflictAuto: 1,
	});
});

test("conflict: the stronger side can be b", async () => {
	const { w, deps, conflict } = await setup();
	await canonical(deps, { id: "c1", vec: similar[0], atoms: 1 });
	await canonical(deps, { id: "c2", vec: similar[1], atoms: 4, records: 2 });
	w.llm.when(isJudgePrompt, verdictFor("conflict"));
	await newRun(deps, "r1");
	await conflict.start("conflict", "r1", { dryRun: false });
	await drain(deps);
	expect(deps.store.read((db) => getKnowledgeById(db, "c1")!.status)).toBe(
		"retracted",
	);
	expect(
		deps.store.read((db) => getPairJudgment(db, "c1", "c2"))!.resolution,
	).toBe("b_wins");
	expect(
		deps.store.read((db) => edgesFrom(db, "knowledge", "c2", "contradicts")),
	).toHaveLength(1);
});

test("conflict: a close contest, and a high importance, go to the owner with the figures", async () => {
	const { w, deps, conflict } = await setup();
	await canonical(deps, { id: "c1", vec: similar[0], atoms: 2 });
	await canonical(deps, { id: "c2", vec: similar[1], atoms: 2, used: 1 });
	await canonical(deps, {
		id: "d1",
		vec: unit(0, 0, 1),
		atoms: 5,
		records: 3,
		over: { importance: 0.9 },
	});
	await canonical(deps, { id: "d2", vec: unit(0, 0.05, 1), atoms: 1 });
	w.llm.when(isJudgePrompt, verdictFor("conflict"));
	await newRun(deps, "r1");
	await conflict.start("conflict", "r1", { dryRun: false });
	await drain(deps);
	expect(
		deps.store.read((db) =>
			["c1", "c2", "d1", "d2"].map((id) => getKnowledgeById(db, id)!.status),
		),
	).toEqual(["active", "active", "active", "active"]);
	const reviews = deps.store.read((db) => listReviews(db, "open"));
	expect(
		reviews.map((r) => [
			r.id.split(":").slice(0, 3).join(":"),
			r.kind,
			r.proposal.reason,
		]),
	).toEqual([
		["conflict:c1:c2", "conflict", "close"],
		["conflict:d1:d2", "conflict", "importance"],
	]);
	// c1: log2(3) + log2(3) = 3.17;  c2: 3.17 + 0.5 = 3.67
	const strength = reviews[0]!.proposal.strength as {
		a: { score: number };
		b: { score: number };
	};
	expect(strength.a.score).toBeCloseTo(3.17, 2);
	expect(strength.b.score).toBeCloseTo(3.67, 2);
	expect(
		deps.store.read((db) => getPairJudgment(db, "c1", "c2"))!.resolution,
	).toBe("owner_pending");
	expect(reviews[0]!.subject).toMatchObject({ type: "pair", a: "c1", b: "c2" });
});

test("unknown, and an answer that stays invalid, go to the owner without changing a row", async () => {
	const { w, deps, conflict } = await setup();
	await canonical(deps, { id: "c1", vec: similar[0] });
	await canonical(deps, { id: "c2", vec: similar[1] });
	await canonical(deps, { id: "d1", vec: unit(0, 0, 1) });
	await canonical(deps, { id: "d2", vec: unit(0, 0.05, 1) });
	// one batch whose answer is not JSON (twice: the repair round fails too)
	w.llm.when(isJudgePrompt, "not json at all");
	await newRun(deps, "r1");
	await conflict.start("conflict", "r1", { dryRun: false });
	await drain(deps);
	const open = deps.store.read((db) => listReviews(db, "open"));
	expect(
		open.map((r) => [r.id.split(":").slice(0, 3).join(":"), r.proposal.reason]),
	).toEqual([
		["conflict:c1:c2", "llm_invalid_output"],
		["conflict:d1:d2", "llm_invalid_output"],
	]);
	for (const [a, b] of [
		["c1", "c2"],
		["d1", "d2"],
	] as const)
		expect(deps.store.read((db) => getPairJudgment(db, a, b))).toMatchObject({
			verdict: "unknown",
			resolution: "owner_pending",
			detail: { invalid: true },
		});
	const run = deps.store.read((db) => getRun(db, "r1"))!;
	expect(run.state).toBe("completed");
	expect(run.counts).toMatchObject({ pairsJudged: 2, reviewsOpened: 2 });

	// a model that says unknown
	const second = await setup();
	await canonical(second.deps, { id: "e1", vec: similar[0] });
	await canonical(second.deps, { id: "e2", vec: similar[1] });
	second.w.llm.when(isJudgePrompt, verdictFor("unknown"));
	await newRun(second.deps, "r1");
	await second.conflict.start("conflict", "r1", { dryRun: false });
	await drain(second.deps);
	expect(
		second.deps.store.read((db) => listReviews(db, "open"))[0]!.proposal,
	).toMatchObject({ reason: "unknown" });
});

test("a condition_split without conditions is unknown; compatible and unrelated need no resolve job", async () => {
	const { w, deps, conflict } = await setup();
	await canonical(deps, { id: "c1", vec: similar[0] });
	await canonical(deps, { id: "c2", vec: similar[1] });
	await canonical(deps, { id: "d1", vec: unit(0, 0, 1) });
	await canonical(deps, { id: "d2", vec: unit(0, 0.05, 1) });
	w.llm.when(
		isJudgePrompt,
		byPair({ "c1|c2": "condition_split", "d1|d2": "compatible" }),
	);
	await newRun(deps, "r1");
	await conflict.start("conflict", "r1", { dryRun: false });
	await drain(deps);
	expect(
		deps.store.read((db) => getPairJudgment(db, "c1", "c2"))!.verdict,
	).toBe("unknown");
	const d = deps.store.read((db) => getPairJudgment(db, "d1", "d2"))!;
	expect(d).toMatchObject({
		verdict: "compatible",
		resolution: "none",
		detail: { aNotAppliesWhen: [] },
	});
	expect(deps.store.read((db) => getRun(db, "r1"))!.counts.jobs).toBe(1);
});

test("a permanent provider error fails the job and the run, and is counted", async () => {
	const { w, deps, conflict } = await setup();
	await canonical(deps, { id: "c1", vec: similar[0] });
	await canonical(deps, { id: "c2", vec: similar[1] });
	w.llm.when(isJudgePrompt, new LarmError("larm_provider_conflict"));
	await newRun(deps, "r1");
	await conflict.start("conflict", "r1", { dryRun: false });
	await drain(deps);
	const run = deps.store.read((db) => getRun(db, "r1"))!;
	expect(run.state).toBe("failed");
	expect(run.counts).toMatchObject({ jobs: 1, jobsSettled: 1, jobsFailed: 1 });
	expect(deps.store.read((db) => getPairJudgment(db, "c1", "c2"))).toBeNull();
	expect(classify(new LarmError("larm_busy", 1000))).toBe("retry");
	expect(classify(new LarmError("larm_unreachable"))).toBe("retry");
	expect(classify(new LarmError("larm_deploying"))).toBe("retry");
	expect(classify(new LarmError("larm_provider_conflict"))).toBe("fail");
	expect(classify(new Error("x"))).toBe("fail");
});

test("a pair that is no longer active when its job runs is skipped and the run still completes", async () => {
	const { deps, conflict } = await setup();
	await canonical(deps, { id: "c1", vec: similar[0] });
	await canonical(deps, { id: "c2", vec: similar[1] });
	await newRun(deps, "r1");
	await conflict.start("conflict", "r1", { dryRun: false });
	await deps.store.write((db) =>
		setKnowledgeDisposition(db, "c2", { status: "retracted", updatedAt: T0 }),
	);
	await drain(deps);
	const run = deps.store.read((db) => getRun(db, "r1"))!;
	expect(run.state).toBe("completed");
	expect(run.counts).toMatchObject({ jobs: 1, jobsSettled: 1 });
});

test("judgePairs: any two knowledge ids, stored judgments reused, unknown ids unknown, 8 pairs a call", async () => {
	const { w, deps, conflict } = await setup();
	const ids = ["p1", "p2", "p3", "p4", "p5"];
	for (const [i, id] of ids.entries())
		await canonical(deps, { id, vec: unit(1, i * 0.01, 0) });
	const all: { a: string; b: string }[] = [];
	for (let i = 0; i < ids.length; i++)
		for (let j = i + 1; j < ids.length; j++)
			all.push({ a: ids[i]!, b: ids[j]! });
	expect(all).toHaveLength(10);
	w.llm.when(isJudgePrompt, verdictFor("conflict"));
	const verdicts = await conflict.judgePairs([...all, { a: "p1", b: "ghost" }]);
	expect(verdicts).toHaveLength(11);
	expect(verdicts.slice(0, 10).every((v) => v.verdict === "conflict")).toBe(
		true,
	);
	expect(verdicts[10]).toMatchObject({
		a: "p1",
		b: "ghost",
		verdict: "unknown",
		note: "not_found",
	});
	expect(w.llm.calls).toHaveLength(2); // 8 + 2
	// the same pairs again are answered by the answer cache, no model call
	await conflict.judgePairs(all);
	expect(w.llm.calls).toHaveLength(2);
	// judgePairs never writes a judgment or a resolution
	expect(deps.store.read((db) => getPairJudgment(db, "p1", "p2"))).toBeNull();
});

test("judgePairs: a stored judgment of the stage is returned in the caller's orientation", async () => {
	const { w, deps, conflict } = await setup();
	await canonical(deps, { id: "c1", vec: similar[0] });
	await canonical(deps, { id: "c2", vec: similar[1] });
	const pair = deps.store.read((db) => scanCandidates(db, SPACE_KEY).pairs[0]!);
	await deps.store.write((db) =>
		upsertPairJudgment(db, {
			aId: "c1",
			bId: "c2",
			aDigest: pair.aDigest,
			bDigest: pair.bDigest,
			verdict: "condition_split",
			resolution: "split",
			detail: {
				aNotAppliesWhen: ["x"],
				bNotAppliesWhen: ["y"],
				note: "stored",
			},
			callId: null,
			at: T0,
		}),
	);
	const [v] = await conflict.judgePairs([{ a: "c2", b: "c1" }]);
	expect(v).toEqual({
		a: "c2",
		b: "c1",
		verdict: "condition_split",
		aNotAppliesWhen: ["y"],
		bNotAppliesWhen: ["x"],
		note: "stored",
	});
	expect(w.llm.calls).toHaveLength(0);
});

test("judgePairs: a larm error is thrown to the caller; an unusable answer is unknown", async () => {
	const { w, conflict, deps } = await setup();
	await canonical(deps, { id: "c1", vec: similar[0] });
	await canonical(deps, { id: "c2", vec: similar[1] });
	w.llm.when(isJudgePrompt, "garbage");
	const [v] = await conflict.judgePairs([{ a: "c1", b: "c2" }]);
	expect(v!.verdict).toBe("unknown");
	const w2 = await setup();
	await canonical(w2.deps, { id: "c1", vec: similar[0] });
	await canonical(w2.deps, { id: "c2", vec: similar[1] });
	w2.w.llm.when(isJudgePrompt, new LarmError("larm_busy", 5));
	await expect(
		w2.conflict.judgePairs([{ a: "c1", b: "c2" }]),
	).rejects.toBeInstanceOf(LarmError);
});

// ---- the fix batch --------------------------------------------------------------------

const workRows = (deps: World["deps"]) =>
	deps.store.read(
		(db) =>
			(
				db
					.query(
						"SELECT count(*) AS n FROM distill_params WHERE key LIKE 'conflict.work.%'",
					)
					.get() as { n: number }
			).n,
	);

test("R1-1: a resolve job that carries another stage's run does not close that run", async () => {
	const { deps } = await setup();
	await canonical(deps, { id: "c1", vec: similar[0] });
	await canonical(deps, { id: "c2", vec: similar[1] });
	const pair = deps.store.read((db) => scanCandidates(db, SPACE_KEY).pairs[0]!);
	await deps.store.write((db) => {
		upsertPairJudgment(db, {
			aId: "c1",
			bId: "c2",
			aDigest: pair.aDigest,
			bDigest: pair.bDigest,
			verdict: "duplicate",
			resolution: "none",
			detail: {},
			callId: null,
			at: T0,
		});
	});
	await newRun(deps, "rc", "canonical");
	await deps.store.write((db) => enqueueResolveJob(deps, db, "rc", pair));
	await drain(deps);
	const run = deps.store.read((db) => getRun(db, "rc"))!;
	expect(run.state).toBe("running");
	expect(run.counts).toEqual({});
	// the job itself ran: the merge cluster exists
	expect(
		deps.store.read((db) => getCluster(db, mergeClusterId("c1", "c2"))),
	).not.toBeNull();
});

test("R1-2: a run over many pairs keeps a window of jobs open, tops it up as jobs settle, and then finishes", async () => {
	const { w, deps, conflict } = await setup();
	for (let i = 0; i < 20; i++)
		await canonical(deps, {
			id: `K${String(i).padStart(2, "0")}`,
			vec: unit(Math.cos(i), Math.sin(i), 0),
			clusterId: "big",
		});
	w.llm.when(isJudgePrompt, verdictFor("compatible"));
	await newRun(deps, "r1");
	// 190 pairs: 24 jobs of up to 8 pairs
	expect(await conflict.start("conflict", "r1", { dryRun: false })).toBe(24);
	expect(deps.queue.stats().openJobs).toBe(16);
	expect(workRows(deps)).toBeGreaterThan(0);
	await drain(deps, 600);
	const run = deps.store.read((db) => getRun(db, "r1"))!;
	expect(run.state).toBe("completed");
	expect(run.counts).toMatchObject({
		jobs: 24,
		jobsSettled: 24,
		planned: 24,
		fed: 24,
		pairsJudged: 190,
	});
	expect(workRows(deps)).toBe(0);
});

test("R1-2: a full queue when a duplicate is judged keeps the judgment; the next run resolves it", async () => {
	const w = await world();
	worlds.push(w);
	const deps = w.deps;
	await canonical(deps, { id: "c1", vec: similar[0], atoms: 2 });
	await canonical(deps, { id: "c2", vec: similar[1], atoms: 2 });
	w.llm.when(isJudgePrompt, verdictFor("duplicate"));
	let full = true;
	const refusing = {
		...deps,
		queue: {
			...deps.queue,
			enqueueInTransaction: (
				tx: Parameters<typeof deps.queue.enqueueInTransaction>[0],
				input: Parameters<typeof deps.queue.enqueueInTransaction>[1],
			) => {
				if (full && input.kind === RESOLVE_KIND) throw new Error("queue_full");
				return deps.queue.enqueueInTransaction(tx, input);
			},
		},
	};
	const conflict = createConflict(refusing);
	conflict.registerHandlers();
	await newRun(deps, "r1");
	await conflict.start("conflict", "r1", { dryRun: false });
	await drain(deps);
	const run = deps.store.read((db) => getRun(db, "r1"))!;
	expect(run.state).toBe("completed");
	expect(run.counts).toMatchObject({ pairsJudged: 1, resolveDeferred: 1 });
	expect(
		deps.store.read((db) => getPairJudgment(db, "c1", "c2")),
	).toMatchObject({ verdict: "duplicate", resolution: "none" });
	full = false;
	await newRun(deps, "r2");
	expect(await conflict.start("conflict", "r2", { dryRun: false })).toBe(1);
	await drain(deps);
	expect(
		deps.store.read((db) => getCluster(db, mergeClusterId("c1", "c2"))),
	).not.toBeNull();
});

test("R1-4: the loser is retracted only when a second judgment with another prompt also says conflict", async () => {
	const { w, deps, conflict } = await setup();
	await canonical(deps, { id: "c1", vec: similar[0], atoms: 3, used: 3 });
	await canonical(deps, { id: "c2", vec: similar[1], atoms: 1 });
	w.llm.when(isJudgePrompt, verdictFor("conflict"), verdictFor("compatible"));
	await newRun(deps, "r1");
	await conflict.start("conflict", "r1", { dryRun: false });
	await drain(deps);
	expect(deps.store.read((db) => getKnowledgeById(db, "c2")!.status)).toBe(
		"active",
	);
	const reviews = deps.store.read((db) => listReviews(db, "open"));
	expect(reviews).toHaveLength(1);
	expect(reviews[0]!.proposal).toMatchObject({
		verdict: "conflict",
		reason: "recheck_disagreed",
		recheck: "compatible",
	});
	expect(
		deps.store.read((db) => getPairJudgment(db, "c1", "c2"))!.resolution,
	).toBe("owner_pending");
	expect(deps.store.read((db) => getRun(db, "r1"))!.counts).toMatchObject({
		conflictRecheckDisagreed: 1,
	});
	// the second call used the other wording
	expect(
		w.llm.calls.filter(isJudgePrompt).map((r) => messageText(r)),
	).toHaveLength(2);
	expect(messageText(w.llm.calls.filter(isJudgePrompt)[1]!)).toContain(
		"audit a knowledge base",
	);
});

test("R1-5: a merge cluster that made two canonicals supersedes each old one by the new one that shares its atoms", async () => {
	const { w, deps, conflict } = await setup();
	await canonical(deps, { id: "c1", vec: similar[0] });
	await canonical(deps, { id: "c2", vec: similar[1] });
	w.llm.when(isJudgePrompt, verdictFor("duplicate"));
	await newRun(deps, "r1");
	await conflict.start("conflict", "r1", { dryRun: false });
	await drain(deps);
	const clusterId = mergeClusterId("c1", "c2");
	const derived = (ids: string[]) =>
		ids.map((id) => ({
			targetKind: "atom" as const,
			targetId: id,
			externalRef: null,
			role: "derived_from" as const,
			quote: null,
			confidence: null,
		}));
	await canonical(deps, { id: "n1", vec: null, clusterId, atoms: 0 });
	await canonical(deps, { id: "n2", vec: null, clusterId, atoms: 0 });
	await deps.store.write((db) => {
		replaceKnowledgeEvidence(
			db,
			"n1",
			"pipeline",
			derived(["c1-a1", "c1-a2"]),
			T0,
		);
		replaceKnowledgeEvidence(
			db,
			"n2",
			"pipeline",
			derived(["c2-a1", "c2-a2"]),
			T0,
		);
		setClusterState(db, clusterId, "distilled", T0);
	});
	await newRun(deps, "r2");
	await conflict.start("conflict", "r2", { dryRun: false });
	const edges = deps.store.read((db) => [
		...edgesFrom(db, "knowledge", "n1", "supersedes").map((e) => [
			"n1",
			e.dst.id,
		]),
		...edgesFrom(db, "knowledge", "n2", "supersedes").map((e) => [
			"n2",
			e.dst.id,
		]),
	]);
	expect(edges).toEqual([
		["n1", "c1"],
		["n2", "c2"],
	]);
});

test("R1-6: a review about a pair is one per pair and pair of texts; changed texts open a new one", async () => {
	const { deps } = await setup();
	await canonical(deps, { id: "c1", vec: null });
	await canonical(deps, { id: "c2", vec: null });
	const open = () =>
		deps.store.write((db) =>
			openPairReview(db, {
				kind: "conflict",
				a: "c1",
				b: "c2",
				proposal: {},
				at: T0,
			}),
		);
	expect(await open()).toBe(true);
	expect(await open()).toBe(false);
	await deps.store.write((db) => {
		db.query(
			"UPDATE knowledge_items SET content_digest = 'changed' WHERE id = 'c1'",
		).run();
	});
	expect(await open()).toBe(true);
	expect(deps.store.read((db) => listReviews(db, "open"))).toHaveLength(2);
});

test("R1-9: conditions that name a path or that the texts do not carry go to the owner, and the verifier is not asked", async () => {
	for (const [aNot, bNot] of [
		[["when on Linux"], ["situation c1 body"]],
		[["situation c2 body in src/app/main.ts"], ["situation c1 body"]],
	] as const) {
		const { w, deps, conflict } = await setup();
		await canonical(deps, { id: "c1", vec: similar[0] });
		await canonical(deps, { id: "c2", vec: similar[1] });
		w.llm.when(
			isJudgePrompt,
			verdictFor("condition_split", [...aNot], [...bNot]),
		);
		w.llm.when(isVerifyPrompt, {
			schemaVersion: 1,
			verdict: "supported",
			rationale: "",
		});
		await newRun(deps, "r1");
		await conflict.start("conflict", "r1", { dryRun: false });
		await drain(deps);
		expect(
			deps.store.read((db) => getKnowledgeById(db, "c1")!.notAppliesWhen),
		).toEqual([]);
		expect(
			deps.store.read((db) => getKnowledgeById(db, "c2")!.notAppliesWhen),
		).toEqual([]);
		// only the side that passes is shown to the verifier
		expect(w.llm.calls.filter(isVerifyPrompt)).toHaveLength(1);
		expect(deps.store.read((db) => listReviews(db, "open"))).toMatchObject([
			{ kind: "verifier_unknown", proposal: { verifier: { a: "rejected" } } },
		]);
	}
});

test("R1-10: the candidate scan lets the event loop run and finds what the synchronous scan finds", async () => {
	const { deps } = await setup();
	for (let i = 0; i < 30; i++)
		await canonical(deps, {
			id: `K${String(i).padStart(2, "0")}`,
			vec: unit(Math.cos(i / 10), Math.sin(i / 10), 0.2),
		});
	let ticks = 0;
	let stop = false;
	const spin = () => {
		ticks++;
		if (!stop) setImmediate(spin);
	};
	setImmediate(spin);
	const yielded = await scanCandidatesYielding(deps.store, SPACE_KEY);
	stop = true;
	expect(ticks).toBeGreaterThan(10);
	expect(yielded).toEqual(
		deps.store.read((db) => scanCandidates(db, SPACE_KEY)),
	);
});
