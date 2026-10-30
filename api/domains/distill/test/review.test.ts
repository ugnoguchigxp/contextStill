import { afterEach, expect, test } from "bun:test";
import {
	getKnowledgeById,
	replaceKnowledgeEvidence,
	setKnowledgeDisposition,
	upsertKnowledgeItem,
} from "../../knowledge";
import { edgesFrom, getCluster, upsertCluster } from "../../map";
import { type ReviewDecision, type ReviewKind } from "../contracts";
import {
	getAssessment,
	getPairJudgment,
	getReview,
	insertReview,
	listReviews,
	upsertAssessment,
	upsertPairJudgment,
} from "../repository";
import { openPairReview } from "../service/conflict/apply";
import {
	canonical,
	world,
	unit,
	type World,
} from "../service/conflict/support.test";
import { createReview } from "../service/review";
import { atom, T0 } from "./fixtures";

const worlds: World[] = [];
afterEach(async () => {
	for (const w of worlds.splice(0)) await w.dispose();
});
async function setup() {
	const w = await world();
	worlds.push(w);
	return { w, deps: w.deps, review: createReview(w.deps) };
}

/** Two canonicals with a judgment and the review the stage would have opened. */
async function pairReview(
	deps: World["deps"],
	opts: {
		kind?: "conflict" | "verifier_unknown";
		verdict?: "conflict" | "unknown" | "condition_split";
		detail?: Record<string, unknown>;
		proposal?: Record<string, unknown>;
	} = {},
) {
	await canonical(deps, { id: "c1", vec: unit(1, 0, 0), atoms: 3 });
	await canonical(deps, { id: "c2", vec: unit(1, 0.1, 0), atoms: 1 });
	await deps.store.write((db) => {
		upsertPairJudgment(db, {
			aId: "c1",
			bId: "c2",
			aDigest: getKnowledgeById(db, "c1")!.contentDigest,
			bDigest: getKnowledgeById(db, "c2")!.contentDigest,
			verdict: opts.verdict ?? "conflict",
			resolution: "owner_pending",
			detail: opts.detail ?? { note: "n" },
			callId: null,
			at: T0,
		});
		openPairReview(db, {
			kind: opts.kind ?? "conflict",
			a: "c1",
			b: "c2",
			proposal: opts.proposal ?? {},
			at: T0,
		});
	});
	return deps.store.read(
		(db) =>
			listReviews(db, "open").find(
				(r) => r.kind === (opts.kind ?? "conflict") && r.subject.a === "c1",
			)!.id,
	);
}

const state = (deps: World["deps"], id: string) =>
	deps.store.read((db) => getReview(db, id))!;
const status = (deps: World["deps"], id: string) =>
	deps.store.read((db) => getKnowledgeById(db, id)!.status);

test("conflict a_wins: the loser is retracted, contradicts comes from the owner, the review is settled", async () => {
	const { deps, review } = await setup();
	const id = await pairReview(deps);
	expect(review.listReviews("open").map((r) => r.id)).toEqual([id]);
	await review.resolveReview(id, { kind: "a_wins" });
	expect(status(deps, "c2")).toBe("retracted");
	expect(status(deps, "c1")).toBe("active");
	const edges = deps.store.read((db) =>
		edgesFrom(db, "knowledge", "c1", "contradicts"),
	);
	expect(edges[0]).toMatchObject({
		dst: { id: "c2" },
		origin: "human",
		status: "active",
	});
	expect(
		deps.store.read((db) => getPairJudgment(db, "c1", "c2"))!.resolution,
	).toBe("a_wins");
	const done = state(deps, id);
	expect(done).toMatchObject({
		state: "resolved",
		resolution: { decision: "a_wins" },
	});
	expect(done.resolvedAt).toBe(T0);
	expect(review.listReviews("open")).toEqual([]);
	expect(review.listReviews("resolved")).toHaveLength(1);
});

test("conflict b_wins", async () => {
	const { deps, review } = await setup();
	const id = await pairReview(deps, { verdict: "unknown" });
	await review.resolveReview(id, { kind: "b_wins" });
	expect(status(deps, "c1")).toBe("retracted");
	expect(
		deps.store.read((db) => getPairJudgment(db, "c1", "c2"))!.resolution,
	).toBe("b_wins");
	expect(
		deps.store.read((db) => edgesFrom(db, "knowledge", "c2", "contradicts")),
	).toHaveLength(1);
});

test("conflict keep_both: recorded as compatible by the owner, nothing else changes", async () => {
	const { deps, review } = await setup();
	const id = await pairReview(deps);
	await review.resolveReview(id, { kind: "keep_both" });
	expect(status(deps, "c1")).toBe("active");
	expect(status(deps, "c2")).toBe("active");
	expect(
		deps.store.read((db) => getPairJudgment(db, "c1", "c2")),
	).toMatchObject({
		verdict: "compatible",
		resolution: "owner_resolved",
		detail: { origin: "human" },
	});
});

test("conflict split: the conditions of the judgment are added as they are", async () => {
	const { deps, review } = await setup();
	const id = await pairReview(deps, {
		verdict: "condition_split",
		detail: { aNotAppliesWhen: ["on CI"], bNotAppliesWhen: ["locally"] },
	});
	await review.resolveReview(id, { kind: "split" });
	expect(
		deps.store.read((db) => getKnowledgeById(db, "c1")!.notAppliesWhen),
	).toEqual(["on CI"]);
	expect(
		deps.store.read((db) => getKnowledgeById(db, "c2")!.notAppliesWhen),
	).toEqual(["locally"]);
	expect(
		deps.store.read((db) => getPairJudgment(db, "c1", "c2")),
	).toMatchObject({ verdict: "condition_split", resolution: "split" });
});

test("conflict split without conditions asks the model once; no usable answer leaves everything open", async () => {
	const { w, deps, review } = await setup();
	const id = await pairReview(deps);
	w.llm.queue({
		schemaVersion: 1,
		pairs: [
			{
				index: 0,
				verdict: "unknown",
				aNotAppliesWhen: [],
				bNotAppliesWhen: [],
				note: "",
			},
		],
	});
	await expect(
		review.resolveReview(id, { kind: "split" }),
	).rejects.toMatchObject({ code: "host_rejected" });
	expect(state(deps, id).state).toBe("open");
	expect(
		deps.store.read((db) => getKnowledgeById(db, "c1")!.notAppliesWhen),
	).toEqual([]);
	expect(
		deps.store.read((db) => getPairJudgment(db, "c1", "c2"))!.resolution,
	).toBe("owner_pending");
});

test("conflict split without conditions: a usable proposal from the model is applied", async () => {
	const { w, deps, review } = await setup();
	const id = await pairReview(deps);
	w.llm.queue({
		schemaVersion: 1,
		pairs: [
			{
				index: 0,
				verdict: "condition_split",
				aNotAppliesWhen: ["when A"],
				bNotAppliesWhen: ["when B"],
				note: "",
			},
		],
	});
	await review.resolveReview(id, { kind: "split" });
	expect(
		deps.store.read((db) => getKnowledgeById(db, "c1")!.notAppliesWhen),
	).toEqual(["when A"]);
	expect(
		deps.store.read((db) => getKnowledgeById(db, "c2")!.notAppliesWhen),
	).toEqual(["when B"]);
	expect(
		deps.store.read((db) => getPairJudgment(db, "c1", "c2")),
	).toMatchObject({ verdict: "condition_split", resolution: "split" });
	expect(state(deps, id).state).toBe("resolved");
});

test("verifier_unknown of a split: accept applies the draft, reject keeps both as they are", async () => {
	const { deps, review } = await setup();
	const id = await pairReview(deps, {
		kind: "verifier_unknown",
		verdict: "condition_split",
		detail: {},
		proposal: { aNotAppliesWhen: ["X"], bNotAppliesWhen: ["Y"] },
	});
	await review.resolveReview(id, { kind: "accept" });
	expect(
		deps.store.read((db) => getKnowledgeById(db, "c2")!.notAppliesWhen),
	).toEqual(["Y"]);
	expect(
		deps.store.read((db) => getPairJudgment(db, "c1", "c2"))!.resolution,
	).toBe("split");

	const other = await setup();
	const id2 = await pairReview(other.deps, {
		kind: "verifier_unknown",
		verdict: "condition_split",
		proposal: { aNotAppliesWhen: ["X"], bNotAppliesWhen: ["Y"] },
	});
	await other.review.resolveReview(id2, { kind: "reject" });
	expect(
		other.deps.store.read((db) => getKnowledgeById(db, "c1")!.notAppliesWhen),
	).toEqual([]);
	expect(
		other.deps.store.read((db) => getPairJudgment(db, "c1", "c2"))!.resolution,
	).toBe("owner_resolved");
});

test("dismiss settles any review; a pair that is not a live contradiction is closed with it", async () => {
	const { deps, review } = await setup();
	const id = await pairReview(deps, {
		verdict: "condition_split",
		detail: { aNotAppliesWhen: ["x"], bNotAppliesWhen: ["y"] },
	});
	await review.resolveReview(id, { kind: "dismiss" });
	expect(state(deps, id).state).toBe("dismissed");
	expect(
		deps.store.read((db) => getPairJudgment(db, "c1", "c2"))!.resolution,
	).toBe("owner_resolved");
	expect(status(deps, "c1")).toBe("active");
	expect(status(deps, "c2")).toBe("active");
});

test("errors: unknown id, a settled review, a decision the kind does not take", async () => {
	const { deps, review } = await setup();
	await expect(
		review.resolveReview("nope", { kind: "dismiss" }),
	).rejects.toMatchObject({ code: "distill_not_found" });
	const id = await pairReview(deps);
	for (const decision of [
		{ kind: "accept" },
		{ kind: "reject" },
		{ kind: "set_generality", generality: "general" },
	] as ReviewDecision[]) {
		await expect(review.resolveReview(id, decision)).rejects.toMatchObject({
			code: "invalid_distill_request",
		});
		expect(state(deps, id).state).toBe("open");
	}
	await review.resolveReview(id, { kind: "keep_both" });
	await expect(
		review.resolveReview(id, { kind: "a_wins" }),
	).rejects.toMatchObject({ code: "invalid_distill_request" });
	expect(status(deps, "c2")).toBe("active");
});

test("a conflict review whose judgment is gone writes nothing", async () => {
	const { deps, review } = await setup();
	await canonical(deps, { id: "c1", vec: null });
	await canonical(deps, { id: "c2", vec: null });
	await deps.store.write((db) =>
		openPairReview(db, {
			kind: "conflict",
			a: "c1",
			b: "c2",
			proposal: {},
			at: T0,
		}),
	);
	const id = deps.store.read((db) => listReviews(db, "open"))[0]!.id;
	await expect(
		review.resolveReview(id, { kind: "a_wins" }),
	).rejects.toMatchObject({ code: "invalid_distill_request" });
	expect(status(deps, "c2")).toBe("active");
	expect(state(deps, id).state).toBe("open");
});

async function open(
	deps: World["deps"],
	id: string,
	kind: ReviewKind,
	subject: Record<string, unknown>,
	proposal = {},
) {
	await deps.store.write((db) =>
		insertReview(db, { id, kind, subject, proposal, at: T0 }),
	);
}

test("generality: the owner's grade is stored as human and sets the retrieval of an active atom", async () => {
	const { deps, review } = await setup();
	await deps.store.write((db) => {
		upsertKnowledgeItem(db, atom("k1"));
		upsertKnowledgeItem(db, atom("k2"));
		upsertAssessment(db, {
			ownerKind: "knowledge",
			ownerId: "k1",
			generality: "generalizable",
			signals: { a: 1 },
			reason: "llm",
			origin: "llm",
			contentDigest: getKnowledgeById(db, "k1")!.contentDigest,
			promptVersion: "p1",
			callId: null,
			at: T0,
		});
	});
	await open(deps, "g1", "generality", {
		ownerKind: "knowledge",
		ownerId: "k1",
	});
	await open(deps, "g2", "generality", {
		ownerKind: "knowledge",
		ownerId: "k2",
	});
	await review.resolveReview("g1", {
		kind: "set_generality",
		generality: "repo_specific",
	});
	await review.resolveReview("g2", {
		kind: "set_generality",
		generality: "general",
	});
	const k1 = deps.store.read((db) => getKnowledgeById(db, "k1")!);
	expect(k1.retrieval).toBe("evidence_only");
	expect(
		deps.store.read((db) => getAssessment(db, "knowledge", "k1")),
	).toMatchObject({
		generality: "repo_specific",
		origin: "human",
		signals: { a: 1 },
		promptVersion: "p1",
	});
	expect(deps.store.read((db) => getKnowledgeById(db, "k2")!.retrieval)).toBe(
		"searchable",
	);
	expect(
		deps.store.read((db) => getAssessment(db, "knowledge", "k2")),
	).toMatchObject({ generality: "general", origin: "human" });
	// back to a general grade brings an active atom back into search
	await open(deps, "g3", "generality", {
		ownerKind: "knowledge",
		ownerId: "k1",
	});
	await review.resolveReview("g3", {
		kind: "set_generality",
		generality: "generalizable",
	});
	expect(deps.store.read((db) => getKnowledgeById(db, "k1")!.retrieval)).toBe(
		"searchable",
	);
	await open(deps, "g4", "generality", {
		ownerKind: "knowledge",
		ownerId: "ghost",
	});
	await expect(
		review.resolveReview("g4", {
			kind: "set_generality",
			generality: "general",
		}),
	).rejects.toMatchObject({ code: "distill_not_found" });
});

test("host_rejected / verifier_unknown of the canonical stage: reject closes the cluster, accept is refused", async () => {
	const { deps, review } = await setup();
	await deps.store.write((db) =>
		upsertCluster(db, {
			id: "cl9",
			kind: "claim",
			parentId: null,
			level: 0,
			name: "",
			aliases: [],
			description: "",
			summary: {},
			state: "review",
			algorithm: "t",
			memberDigest: "d",
			members: [],
			createdAt: T0,
			updatedAt: T0,
		}),
	);
	await open(deps, "h1", "host_rejected", { clusterId: "cl9", atomIds: ["x"] });
	await open(deps, "v1", "verifier_unknown", {
		clusterId: "cl9",
		atomIds: ["x"],
	});
	await expect(
		review.resolveReview("v1", { kind: "accept" }),
	).rejects.toMatchObject({ code: "invalid_distill_request" });
	await expect(
		review.resolveReview("h1", { kind: "accept" }),
	).rejects.toMatchObject({ code: "invalid_distill_request" });
	await review.resolveReview("h1", { kind: "reject" });
	// another review of the cluster is still open: the cluster is not closed by one group
	expect(deps.store.read((db) => getCluster(db, "cl9")!.state)).toBe("review");
	await review.resolveReview("v1", { kind: "reject" });
	expect(deps.store.read((db) => getCluster(db, "cl9")!.state)).toBe(
		"rejected",
	);
	expect(state(deps, "h1")).toMatchObject({
		state: "resolved",
		resolution: { decision: "reject" },
	});
});

test("low_confidence: accept keeps the canonical, reject retracts it and returns its atoms to search", async () => {
	const { deps, review } = await setup();
	const atoms = await canonical(deps, { id: "c1", vec: null, atoms: 2 });
	await canonical(deps, { id: "c2", vec: null, atoms: 1 });
	await open(deps, "l1", "low_confidence", {
		canonicalId: "c1",
		atomIds: atoms,
		reason: "polarity_tie",
	});
	await open(deps, "l2", "low_confidence", {
		canonicalId: "c2",
		atomIds: ["c2-a1"],
		reason: "polarity_tie",
	});
	await review.resolveReview("l2", { kind: "accept" });
	expect(status(deps, "c2")).toBe("active");
	await review.resolveReview("l1", { kind: "reject" });
	expect(status(deps, "c1")).toBe("retracted");
	for (const a of atoms)
		expect(deps.store.read((db) => getKnowledgeById(db, a)!)).toMatchObject({
			status: "active",
			retrieval: "searchable",
		});
});

test("status counts atoms, assessments, clusters, canonicals, open reviews and llm calls", async () => {
	const { w, deps, review } = await setup();
	await canonical(deps, { id: "c1", vec: unit(1, 0, 0), atoms: 2 });
	await canonical(deps, {
		id: "c2",
		vec: null,
		atoms: 1,
		over: { status: "retracted" },
	});
	await canonical(deps, { id: "c3", vec: null, atoms: 0 });
	await deps.store.write((db) => {
		upsertKnowledgeItem(db, atom("u1"));
		upsertKnowledgeItem(db, atom("u2"));
		db.query(
			"UPDATE knowledge_items SET retrieval = 'evidence_only' WHERE id = 'u2'",
		).run();
		upsertAssessment(db, {
			ownerKind: "knowledge",
			ownerId: "u2",
			generality: "repo_specific",
			signals: {},
			reason: "",
			origin: "llm",
			contentDigest: "d",
			promptVersion: "p",
			callId: null,
			at: T0,
		});
	});
	await open(deps, "r1", "generality", {
		ownerKind: "knowledge",
		ownerId: "u1",
	});
	await open(deps, "r2", "conflict", { type: "pair", a: "c1", b: "c3" });
	void w;
	const s = review.status();
	expect(s.atoms).toEqual({
		superseded: 3,
		evidence_only: 1,
		searchable_unabsorbed: 1,
		unassessed: 1,
	});
	expect(s.assessments).toEqual({
		general: 0,
		generalizable: 0,
		repo_specific: 1,
		unusable: 0,
	});
	expect(s.canonicals).toEqual({
		active: 2,
		retracted: 1,
		superseded: 0,
		withoutVector: 1,
	});
	expect(s.reviews).toEqual({
		conflict: 1,
		low_confidence: 0,
		generality: 1,
		verifier_unknown: 0,
		host_rejected: 0,
	});
	expect(s.clusters).toEqual({
		pending: 0,
		distilled: 0,
		review: 0,
		rejected: 0,
		stale: 0,
	});
	expect(s.llm).toEqual({
		calls: 0,
		inputTokens: 0,
		outputTokens: 0,
		invalidOutput: 0,
	});
	expect(s.queue.openJobs).toBe(0);
});

// ---- the fix batch --------------------------------------------------------------------

test("R1-19: a conflict decision needs both canonicals active and the judgment of their current texts", async () => {
	const { deps, review } = await setup();
	const id = await pairReview(deps);
	await deps.store.write((db) =>
		setKnowledgeDisposition(db, "c2", { status: "superseded", updatedAt: T0 }),
	);
	for (const kind of ["a_wins", "b_wins", "keep_both", "split"] as const)
		await expect(review.resolveReview(id, { kind })).rejects.toMatchObject({
			code: "invalid_distill_request",
		});
	expect(status(deps, "c2")).toBe("superseded");
	expect(state(deps, id).state).toBe("open");
	// with both active again, a text that changed since the judgment is refused too
	await deps.store.write((db) => {
		setKnowledgeDisposition(db, "c2", { status: "active", updatedAt: T0 });
		db.query(
			"UPDATE knowledge_items SET content_digest = 'changed' WHERE id = 'c1'",
		).run();
	});
	await expect(
		review.resolveReview(id, { kind: "a_wins" }),
	).rejects.toMatchObject({ code: "invalid_distill_request" });
	expect(status(deps, "c2")).toBe("active");
});

test("R1-19: dismissing a conflict of two active canonicals leaves the contradiction for the audit", async () => {
	const { deps, review } = await setup();
	const id = await pairReview(deps);
	await review.resolveReview(id, { kind: "dismiss" });
	expect(state(deps, id).state).toBe("dismissed");
	expect(
		deps.store.read((db) => getPairJudgment(db, "c1", "c2"))!.resolution,
	).toBe("owner_pending");
	// the pair is moot once a side is no longer active
	const other = await setup();
	const id2 = await pairReview(other.deps);
	await other.deps.store.write((db) =>
		setKnowledgeDisposition(db, "c2", { status: "retracted", updatedAt: T0 }),
	);
	await other.review.resolveReview(id2, { kind: "dismiss" });
	expect(
		other.deps.store.read((db) => getPairJudgment(db, "c1", "c2"))!.resolution,
	).toBe("owner_resolved");
});

test("R1-12: rejecting a low_confidence canonical restores every atom only it stood for, the merged-away canonical, and rejects the cluster", async () => {
	const { deps, review } = await setup();
	// c1 stands on a1, a2 (this review) and an older a3 that a reuse of its id kept
	const atoms = await canonical(deps, {
		id: "c1",
		vec: null,
		atoms: 3,
		clusterId: "cl1",
	});
	// c2 shares a2 with c1 and stays active: a2 does not come back
	await canonical(deps, { id: "c2", vec: null, atoms: 0 });
	await deps.store.write((db) => {
		replaceKnowledgeEvidence(
			db,
			"c2",
			"pipeline",
			[
				{
					targetKind: "atom",
					targetId: atoms[1]!,
					externalRef: null,
					role: "derived_from",
					quote: null,
					confidence: null,
				},
			],
			T0,
		);
		// an orphan that an earlier retract had left retracted
		setKnowledgeDisposition(db, atoms[2]!, {
			status: "retracted",
			updatedAt: T0,
		});
		upsertCluster(db, {
			id: "cl1",
			kind: "claim",
			parentId: null,
			level: 0,
			name: "",
			aliases: [],
			description: "",
			summary: {},
			state: "distilled",
			algorithm: "t",
			memberDigest: "d",
			members: [],
			createdAt: T0,
			updatedAt: T0,
		});
	});
	await open(deps, "l1", "low_confidence", {
		canonicalId: "c1",
		atomIds: [atoms[0]!, atoms[1]!],
		reason: "polarity_tie",
	});
	await review.resolveReview("l1", { kind: "reject" });
	expect(status(deps, "c1")).toBe("retracted");
	const st = (id: string) =>
		deps.store.read((db) => {
			const k = getKnowledgeById(db, id)!;
			return [k.status, k.retrieval];
		});
	expect(st(atoms[0]!)).toEqual(["active", "searchable"]);
	// carried by c2 as well
	expect(st(atoms[1]!)[0]).toBe("superseded");
	// not in the review, but only c1 stood for it
	expect(st(atoms[2]!)).toEqual(["active", "searchable"]);
	expect(deps.store.read((db) => getCluster(db, "cl1")!.state)).toBe(
		"rejected",
	);
});

test("R1-20: rejecting one group of a cluster that has a canonical leaves the cluster distilled", async () => {
	const { deps, review } = await setup();
	await canonical(deps, { id: "c1", vec: null, atoms: 1, clusterId: "cl2" });
	await deps.store.write((db) =>
		upsertCluster(db, {
			id: "cl2",
			kind: "claim",
			parentId: null,
			level: 0,
			name: "",
			aliases: [],
			description: "",
			summary: {},
			state: "review",
			algorithm: "t",
			memberDigest: "d",
			members: [],
			createdAt: T0,
			updatedAt: T0,
		}),
	);
	await open(deps, "h2", "host_rejected", { clusterId: "cl2", atomIds: ["x"] });
	await review.resolveReview("h2", { kind: "reject" });
	expect(deps.store.read((db) => getCluster(db, "cl2")!.state)).toBe(
		"distilled",
	);
});

test("R2-4: the split proposal is made with the request's signal", async () => {
	const { w, deps, review } = await setup();
	const id = await pairReview(deps);
	w.llm.fallback = {
		schemaVersion: 1,
		pairs: [
			{
				index: 0,
				verdict: "unknown",
				aNotAppliesWhen: [],
				bNotAppliesWhen: [],
				note: "",
			},
		],
	};
	const controller = new AbortController();
	controller.abort();
	await expect(
		review.resolveReview(id, { kind: "split" }, controller.signal),
	).rejects.toBeDefined();
	expect(state(deps, id).state).toBe("open");
	// a live signal: the call gets a signal that follows it
	const live = new AbortController();
	await expect(
		review.resolveReview(id, { kind: "split" }, live.signal),
	).rejects.toMatchObject({ code: "host_rejected" });
	const signal = w.llm.calls.at(-1)!.signal!;
	expect(signal.aborted).toBe(false);
	live.abort();
	expect(signal.aborted).toBe(true);
});
