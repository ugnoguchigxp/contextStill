import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { waitFor } from "../../../infrastructure/wait-for";
import {
	getKnowledgeById,
	knowledgeContentDigest,
	listKnowledgeEvidence,
	replaceKnowledgeEvidence,
	upsertKnowledgeItem,
	type KnowledgeInput,
} from "../../knowledge";
import { getCluster, memberDigest, memberKey, upsertCluster } from "../../map";
import { LarmError } from "../../larm";
import { insertUsageEvent } from "../../usage";
import { DistillError, DEFAULT_THRESHOLDS } from "../contracts";
import {
	addRunCounts,
	createRun,
	getAssessment,
	getPairJudgment,
	getRun,
	listReviews,
	setThresholds,
	upsertAssessment,
} from "../repository";
import { acceptReviewedDraft, createCanonical } from "../service/canonical";
import { jobEnded } from "../service/canonical/feed";
import { MERGE_ALGORITHM } from "../service/conflict/apply";
import { createReview } from "../service/review";
import { settleUnit } from "../service/canonical/settle";
import type { UnitInput, UnitResult } from "../service/canonical/types";
import {
	atom,
	createTestDistill,
	messageText,
	seedAtoms,
	T0,
	type TestDistill,
} from "./fixtures";

const ts: TestDistill[] = [];
afterEach(async () => {
	for (const t of ts.splice(0)) {
		await t.deps.queue.close().catch(() => {});
		await t.dispose();
	}
});

// ---- helpers ---------------------------------------------------------------------------

const isPlan = (req: Parameters<typeof messageText>[0]) =>
	messageText(req).includes("atomic knowledge records into canonical");
const isVerify = (req: Parameters<typeof messageText>[0]) =>
	messageText(req).includes("You verify a draft");
const isPlanRepair = (req: Parameters<typeof messageText>[0]) =>
	isPlan(req) && messageText(req).includes("The host checks found");
const isRevise = (req: Parameters<typeof messageText>[0]) =>
	isPlan(req) && messageText(req).includes("did not accept the draft");

const okChecks = {
	conditions: "preserved",
	negation: "preserved",
	exceptions: "preserved",
	numbersAndUnits: "preserved",
	situationFaithful: "preserved",
	noNewMeaning: "preserved",
	noRepoSpecifics: "preserved",
};
const verifyJson = (claims: number, over: Record<string, unknown> = {}) => ({
	schemaVersion: 1,
	verdict: "supported",
	claims: Array.from({ length: claims }, (_, index) => ({
		index,
		entailed: "yes",
	})),
	checks: okChecks,
	rationale: "ok",
	...over,
});

interface DraftOver {
	[key: string]: unknown;
}
const draft = (
	claims: { text: string; support: string[] }[],
	over: DraftOver = {},
) => ({
	type: "rule",
	polarity: "positive",
	title: "Run migrations in one transaction",
	situation: "When applying a database migration that changes several tables",
	guidance: claims.map((c) => c.text).join(" "),
	rationale: "",
	appliesWhen: [],
	notAppliesWhen: [],
	steps: [],
	exceptions: [],
	claims,
	...over,
});
const canonicalGroup = (members: string[], d: unknown) => ({
	members,
	disposition: "canonical",
	canonical: d,
});
const plan = (groups: unknown[], relations: unknown[] = []) => ({
	schemaVersion: 1,
	groups,
	relations,
});

interface PromptAtom {
	ref: string;
	title: string;
	body: string;
	polarity: "positive" | "negative";
}
function promptAtoms(req: Parameters<typeof messageText>[0]): PromptAtom[] {
	const m = /Atoms \(JSON\):\n(\[[^\n]*\])/.exec(messageText(req));
	return m ? (JSON.parse(m[1]!) as PromptAtom[]) : [];
}
/** Plans by itself: one group per atom for singles, otherwise one group of all atoms. */
function autoPlan(req: Parameters<typeof messageText>[0]) {
	const atoms = promptAtoms(req);
	const make = (list: PromptAtom[]) =>
		canonicalGroup(
			list.map((a) => a.ref),
			draft(
				list.map((a) => ({ text: a.body, support: [a.ref] })),
				{ title: list[0]!.title, polarity: list[0]!.polarity },
			),
		);
	return plan(
		messageText(req).includes("unrelated to each other")
			? atoms.map((a) => make([a]))
			: [make(atoms)],
	);
}
function autoVerify(req: Parameters<typeof messageText>[0]) {
	const m = /Draft \(JSON\):\n([^\n]*)/.exec(messageText(req));
	const claims = (JSON.parse(m![1]!) as { claims: unknown[] }).claims.length;
	return verifyJson(claims);
}

const text = (id: string, extra = "") =>
	`Run each database migration of ${id} inside one transaction so a failure leaves no partial change${extra}.`;
const mk = (id: string, over: Partial<KnowledgeInput> = {}) =>
	atom(id, { title: `Transaction ${id}`, body: text(id), ...over });

async function setup(opts: { calibrated?: boolean } = {}) {
	const t = createTestDistill();
	ts.push(t);
	if (opts.calibrated !== false)
		await t.deps.store.write((db) =>
			setThresholds(db, { ...DEFAULT_THRESHOLDS, calibratedAt: T0 }, T0),
		);
	const module = createCanonical(t.deps);
	module.registerHandlers();
	// The conflict stage owns distill.resolve; here it only records that it was asked.
	const resolves: unknown[] = [];
	t.deps.queue.registerHandler({
		kind: "distill.resolve",
		payloadVersions: [1],
		schema: z.object({ runId: z.string(), a: z.string(), b: z.string() }),
		recovery: "replay_safe",
		resourceKey: "llm",
		prepareInTransaction: (_tx, claim) => ({
			status: "ready",
			input: claim.payload,
		}),
		execute: async (input) => {
			resolves.push(input);
			return null;
		},
		settleInTransaction: () => "applied",
		cancelInTransaction: () => {},
	});
	return { t, module, resolves };
}

async function seedCluster(
	t: TestDistill,
	id: string,
	atomIds: string[],
	algorithm = "test",
) {
	await t.deps.store.write((db) => {
		const rows = atomIds.map((i) => getKnowledgeById(db, i)!);
		const digests = new Map(
			rows.map((r) => [memberKey("knowledge", r.id), r.contentDigest]),
		);
		const members = atomIds.map((aid) => ({
			kind: "knowledge" as const,
			id: aid,
			role: "member" as const,
			similarity: 0.95,
		}));
		upsertCluster(db, {
			id,
			kind: "claim",
			parentId: null,
			level: 0,
			name: "",
			aliases: [],
			description: "",
			summary: {},
			state: "pending",
			algorithm,
			memberDigest: memberDigest(members, digests),
			members,
			createdAt: T0,
			updatedAt: T0,
		});
	});
}

async function assess(t: TestDistill, ids: string[], generality = "general") {
	await t.deps.store.write((db) => {
		for (const id of ids)
			upsertAssessment(db, {
				ownerKind: "knowledge",
				ownerId: id,
				generality: generality as "general",
				signals: {},
				reason: "",
				origin: "llm",
				contentDigest: getKnowledgeById(db, id)!.contentDigest,
				promptVersion: "test",
				callId: null,
				at: T0,
			});
	});
}

let runCounter = 0;
async function startRun(
	t: TestDistill,
	module: ReturnType<typeof createCanonical>,
	stage: "canonical" | "embed" = "canonical",
	opts: { limit?: number; dryRun?: boolean } = {},
) {
	const runId = `run_${++runCounter}`;
	await t.deps.store.write((db) =>
		createRun(db, { id: runId, stage, params: { ...opts }, at: T0 }),
	);
	const enqueued = await module.start(stage, runId, {
		dryRun: false,
		...opts,
	});
	return { runId, enqueued };
}
/** Ticks the queue until the run is no longer running. */
async function drain(t: TestDistill, runId: string) {
	await waitFor(
		async () => {
			await t.deps.queue.tick();
			return t.deps.store.read((db) => getRun(db, runId))?.state !== "running";
		},
		{ timeout: 15_000, interval: 5 },
	);
	return t.deps.store.read((db) => getRun(db, runId))!;
}
const row = (t: TestDistill, id: string) =>
	t.deps.store.read((db) => getKnowledgeById(db, id));
const canonicals = (t: TestDistill) =>
	t.deps.store
		.read(
			(db) =>
				db
					.query(
						"SELECT id FROM knowledge_items WHERE layer = 'canonical' ORDER BY seq",
					)
					.all() as { id: string }[],
		)
		.map((r) => r.id);
const reviews = (t: TestDistill, state: "open" = "open") =>
	t.deps.store.read((db) => listReviews(db, state));
const clusterState = (t: TestDistill, id: string) =>
	t.deps.store.read((db) => getCluster(db, id))!.state;

// ---- tests -----------------------------------------------------------------------------

test("a cluster becomes one canonical: columns, evidence, supersedes, atoms retired, embed queued", async () => {
	const { t, module } = await setup();
	await seedAtoms(t.deps, [
		mk("atom-01", {
			facets: { domains: ["database"], technologies: ["sqlite"] },
			importance: 0.4,
			confidence: 0.7,
			space: "coding",
		}),
		mk("atom-02", {
			facets: { domains: ["database", "migration"] },
			importance: 0.9,
			confidence: 0.8,
			space: "coding",
			provenanceStatus: "source_missing",
		}),
		mk("atom-03", {
			confidence: 0.6,
			space: "general",
			provenanceStatus: "external",
			scope: "repo",
			repoKey: "somerepo",
		}),
	]);
	await assess(t, ["atom-01", "atom-02", "atom-03"]);
	await t.deps.store.write((db) => {
		for (const [id, verdict] of [
			["atom-01", "used"],
			["atom-01", "used"],
			["atom-02", "not_used"],
			["atom-03", "presented"],
		] as const)
			insertUsageEvent(db, {
				id: crypto.randomUUID(),
				ownerKind: "knowledge",
				ownerId: id,
				channel: "search",
				verdict,
				actor: "agent",
				runRef: null,
				reason: null,
				origin: "live",
				occurredAt: T0,
				metadata: {},
			});
	});
	await seedCluster(t, "c1", ["atom-01", "atom-02", "atom-03"]);
	const claims = [
		{ text: text("atom-01"), support: ["a1", "a2"] },
		{ text: text("atom-03"), support: ["a3"] },
	];
	t.llm.when(isVerify, verifyJson(2));
	t.llm.when(isPlan, plan([canonicalGroup(["a1", "a2", "a3"], draft(claims))]));

	const { runId, enqueued } = await startRun(t, module);
	expect(enqueued).toBe(1);
	const run = await drain(t, runId);
	expect(run.state).toBe("completed");
	expect(run.counts).toMatchObject({
		enqueued: 1,
		settled: 1,
		canonicals: 1,
		superseded: 3,
		embedQueued: 1,
	});

	const [id] = canonicals(t);
	const c = row(t, id!)!;
	expect(c).toMatchObject({
		layer: "canonical",
		status: "active",
		retrieval: "searchable",
		scope: "global",
		repoKey: null,
		space: "coding",
		type: "rule",
		polarity: "positive",
		title: "Run migrations in one transaction",
		situation: "When applying a database migration that changes several tables",
		importance: 0.9,
		provenanceStatus: "resolved",
	});
	expect(c.body).toBe(claims.map((x) => x.text).join(" "));
	expect(c.facets).toEqual({
		domains: ["database", "migration"],
		technologies: ["sqlite"],
	});
	// max 0.8 + 0.05 * log2(3)
	expect(c.confidence).toBeCloseTo(0.8 + 0.05 * Math.log2(3), 10);
	expect(c.metadata.usage).toEqual({ used: 2, notUsed: 1 });
	expect(c.metadata.distill).toMatchObject({
		clusterId: "c1",
		promptVersion: "canonical.v1",
	});
	expect(
		(c.metadata.distill as { plannerCallId: string }).plannerCallId,
	).toMatch(/^lc_/);
	expect(c.contentDigest).toBe(
		knowledgeContentDigest(c.title, c.body, c.situation),
	);

	const evidence = t.deps.store.read((db) => listKnowledgeEvidence(db, id!));
	expect(evidence.map((e) => [e.targetId, e.role, e.origin])).toEqual([
		["atom-01", "derived_from", "pipeline"],
		["atom-02", "derived_from", "pipeline"],
		["atom-03", "derived_from", "pipeline"],
	]);
	expect(evidence[0]!.quote).toBe(text("atom-01"));
	expect(evidence[2]!.quote).toBe(text("atom-03"));

	for (const atomId of ["atom-01", "atom-02", "atom-03"]) {
		expect(row(t, atomId)).toMatchObject({
			status: "superseded",
			retrieval: "evidence_only",
		});
		const edge = t.deps.store.read(
			(db) =>
				db
					.query(
						`SELECT origin, status FROM map_edges WHERE src_id = ? AND relation = 'supersedes' AND dst_id = ?`,
					)
					.get(id!, atomId) as { origin: string; status: string } | null,
		);
		expect(edge).toEqual({ origin: "llm", status: "active" });
	}
	expect(clusterState(t, "c1")).toBe("distilled");
	// the embedding ran (the fake reports nothing embedded) and closed the run
	expect(
		t.deps.queue.list({ kind: "distill.embed" }).items.map((j) => j.state),
	).toEqual(["completed"]);
	expect(reviews(t)).toEqual([]);
});

test("a cluster splits into subsets; a repo_specific group is only evidence", async () => {
	const { t, module } = await setup();
	await seedAtoms(t.deps, [
		mk("atom-01"),
		mk("atom-02"),
		mk("atom-03", {
			body: "The deploy script of this repo needs port forwarding on localhost:3000",
		}),
		mk("atom-04", {
			body: "Never delete the lock file while a writer holds it",
		}),
	]);
	await assess(t, ["atom-01", "atom-02", "atom-03", "atom-04"]);
	await seedCluster(t, "c1", ["atom-01", "atom-02", "atom-03", "atom-04"]);
	t.llm.when(isVerify, verifyJson(1));
	t.llm.when(
		isPlan,
		plan([
			canonicalGroup(
				["a1", "a2"],
				draft([{ text: text("atom-01"), support: ["a1", "a2"] }]),
			),
			{ members: ["a3"], disposition: "repo_specific", canonical: null },
			canonicalGroup(
				["a4"],
				draft(
					[
						{
							text: "Never delete the lock file while a writer holds it",
							support: ["a4"],
						},
					],
					{
						title: "Keep the lock file",
						situation:
							"When cleaning up files next to a running database writer",
						polarity: "negative",
					},
				),
			),
		]),
	);
	// polarity of atom-04 is positive in the fixture: make it negative
	await t.deps.store.write((db) => {
		const r = getKnowledgeById(db, "atom-04")!;
		db.query(
			"UPDATE knowledge_items SET polarity = 'negative' WHERE id = ?",
		).run(r.id);
	});
	// the cluster digest does not include polarity, so the cluster is still current
	const { runId } = await startRun(t, module);
	const run = await drain(t, runId);
	expect(run.counts).toMatchObject({
		canonicals: 2,
		repo_specific: 1,
		evidenceOnly: 1,
	});
	expect(canonicals(t)).toHaveLength(2);
	expect(row(t, "atom-03")).toMatchObject({
		status: "active",
		retrieval: "evidence_only",
	});
	expect(
		t.deps.store.read((db) => getAssessment(db, "knowledge", "atom-03")),
	).toMatchObject({ generality: "repo_specific", origin: "llm" });
	expect(row(t, "atom-01")!.status).toBe("superseded");
	expect(row(t, "atom-04")!.status).toBe("superseded");
	expect(clusterState(t, "c1")).toBe("distilled");
});

test("a host violation is sent back once and the corrected answer is used", async () => {
	const { t, module } = await setup();
	await seedAtoms(t.deps, [mk("atom-01"), mk("atom-02")]);
	await assess(t, ["atom-01", "atom-02"]);
	await seedCluster(t, "c1", ["atom-01", "atom-02"]);
	const good = canonicalGroup(
		["a1", "a2"],
		draft([{ text: text("atom-01"), support: ["a1", "a2"] }]),
	);
	const bad = canonicalGroup(
		["a1", "a2"],
		draft([
			{
				text: "Always wrap the writes in a savepoint of 99 retries",
				support: ["a1"],
			},
		]),
	);
	t.llm.when(isVerify, verifyJson(1));
	t.llm.when(isPlanRepair, plan([good]));
	t.llm.when(isPlan, plan([bad]));
	const { runId } = await startRun(t, module);
	const run = await drain(t, runId);
	expect(run.counts).toMatchObject({ canonicals: 1 });
	const repairCall = t.llm.calls.find(isPlanRepair)!;
	// the repair message names the kind and the place, not a quotation of the model's sentence
	expect(messageText(repairCall)).toContain(
		"claim_unsupported (group 0): claim 0",
	);
	expect(t.llm.calls.filter(isPlan)).toHaveLength(2);
	expect(reviews(t)).toEqual([]);
});

test("a second host violation sends the group to host_rejected and changes no atom", async () => {
	const { t, module } = await setup();
	await seedAtoms(t.deps, [mk("atom-01"), mk("atom-02")]);
	await assess(t, ["atom-01", "atom-02"]);
	await seedCluster(t, "c1", ["atom-01", "atom-02"]);
	// a repo name of another atom's repo leaks into the title
	await seedAtoms(t.deps, [
		mk("atom-09", { scope: "repo", repoKey: "nightworkers" }),
	]);
	t.llm.when(isVerify, verifyJson(1));
	t.llm.when(
		isPlan,
		plan([
			canonicalGroup(
				["a1", "a2"],
				draft([{ text: text("atom-01"), support: ["a1", "a2"] }], {
					title: "How nightworkers runs migrations",
				}),
			),
		]),
	);
	const { runId } = await startRun(t, module);
	const run = await drain(t, runId);
	expect(run.counts).toMatchObject({ host_rejected: 1, reviews: 1 });
	expect(canonicals(t)).toEqual([]);
	expect(row(t, "atom-01")).toMatchObject({
		status: "active",
		retrieval: "searchable",
	});
	const [review] = reviews(t);
	expect(review).toMatchObject({ kind: "host_rejected", state: "open" });
	expect(review!.subject).toMatchObject({
		clusterId: "c1",
		atomIds: ["atom-01", "atom-02"],
	});
	expect(
		(review!.proposal.violations as { code: string; detail: string }[]).map(
			(v) => v.code,
		),
	).toEqual(["repo_specific_text"]);
	expect(
		(review!.proposal.draft as { claims: { supportIds: string[] }[] })
			.claims[0]!.supportIds,
	).toEqual(["atom-01", "atom-02"]);
	expect(clusterState(t, "c1")).toBe("review");
	expect(t.llm.calls.filter(isPlan)).toHaveLength(2);
});

test("a rejected verdict revises the group once; the revision is verified again", async () => {
	const { t, module } = await setup();
	await seedAtoms(t.deps, [mk("atom-01"), mk("atom-02")]);
	await assess(t, ["atom-01", "atom-02"]);
	await seedCluster(t, "c1", ["atom-01", "atom-02"]);
	const first = draft([{ text: text("atom-01"), support: ["a1", "a2"] }], {
		title: "First title",
	});
	const second = draft([{ text: text("atom-01"), support: ["a1", "a2"] }], {
		title: "Revised title",
	});
	t.llm.when(isRevise, plan([canonicalGroup(["a1", "a2"], second)]));
	t.llm.when(isPlan, plan([canonicalGroup(["a1", "a2"], first)]));
	t.llm.when(
		isVerify,
		verifyJson(1, {
			verdict: "rejected",
			claims: [{ index: 0, entailed: "no" }],
			checks: { ...okChecks, conditions: "not_preserved" },
			rationale: "drops a condition",
		}),
		verifyJson(1),
	);
	const { runId } = await startRun(t, module);
	await drain(t, runId);
	const [id] = canonicals(t);
	expect(row(t, id!)!.title).toBe("Revised title");
	const revise = messageText(t.llm.calls.find(isRevise)!);
	expect(revise).toContain("checks not preserved: conditions");
	expect(revise).toContain("claims not entailed by the atoms: 0");
	expect(reviews(t)).toEqual([]);
});

test("verifier unknown, or rejected twice, goes to verifier_unknown", async () => {
	const { t, module } = await setup();
	await seedAtoms(t.deps, [
		mk("atom-01"),
		mk("atom-02"),
		mk("atom-11"),
		mk("atom-12"),
	]);
	await assess(t, ["atom-01", "atom-02", "atom-11", "atom-12"]);
	await seedCluster(t, "c1", ["atom-01", "atom-02"]);
	await seedCluster(t, "c2", ["atom-11", "atom-12"]);
	t.llm.when(isPlan, autoPlan);
	// c1: unknown at once; c2: rejected, revised, rejected again
	const unknown = verifyJson(1, {
		verdict: "unknown",
		checks: { ...okChecks, exceptions: "unknown" },
	});
	const rejected = verifyJson(1, {
		verdict: "rejected",
		claims: [{ index: 0, entailed: "no" }],
	});
	t.llm.when(
		(req) => isVerify(req) && messageText(req).includes("atom-01"),
		unknown,
	);
	t.llm.when((req) => isVerify(req), rejected);
	const { runId } = await startRun(t, module);
	const run = await drain(t, runId);
	expect(canonicals(t)).toEqual([]);
	expect(run.counts).toMatchObject({ verifier_unknown: 2, reviews: 2 });
	expect(reviews(t).map((r) => r.kind)).toEqual([
		"verifier_unknown",
		"verifier_unknown",
	]);
	expect(clusterState(t, "c1")).toBe("review");
	expect(clusterState(t, "c2")).toBe("review");
	// c1: one verifier call. c2: verifier, revision, and the same draft again (the stored answer is reused)
	expect(t.llm.calls.filter(isVerify)).toHaveLength(2);
	expect(t.llm.calls.filter(isRevise)).toHaveLength(1);
	expect(row(t, "atom-01")!.status).toBe("active");
});

test("a conflict relation records a judgment and queues distill.resolve; condition_split keeps both", async () => {
	const { t, module, resolves } = await setup();
	await seedAtoms(t.deps, [
		mk("atom-01"),
		mk("atom-02", {
			body: "Never run a database migration inside a transaction on sqlite files",
		}),
		mk("atom-03", {
			body: "Run schema changes in a transaction only when the table is small",
		}),
	]);
	await assess(t, ["atom-01", "atom-02", "atom-03"]);
	await seedCluster(t, "c1", ["atom-01", "atom-02", "atom-03"]);
	const groups = [
		canonicalGroup(
			["a1"],
			draft([{ text: text("atom-01"), support: ["a1"] }], { title: "G one" }),
		),
		canonicalGroup(
			["a2"],
			draft(
				[
					{
						text: "Never run a database migration inside a transaction on sqlite files",
						support: ["a2"],
					},
				],
				{ title: "G two", polarity: "negative" },
			),
		),
		canonicalGroup(
			["a3"],
			draft(
				[
					{
						text: "Run schema changes in a transaction only when the table is small",
						support: ["a3"],
					},
				],
				{ title: "G three" },
			),
		),
	];
	await t.deps.store.write((db) =>
		db
			.query(
				"UPDATE knowledge_items SET polarity='negative' WHERE id='atom-02'",
			)
			.run(),
	);
	t.llm.when(isVerify, verifyJson(1));
	t.llm.when(
		isPlan,
		plan(groups, [
			{ a: 0, b: 1, kind: "conflict", note: "opposite instructions" },
			{ a: 0, b: 2, kind: "condition_split", note: "depends on the size" },
			{ a: 1, b: 7, kind: "conflict", note: "bad index" },
		]),
	);
	const { runId } = await startRun(t, module);
	const run = await drain(t, runId);
	expect(run.counts).toMatchObject({
		canonicals: 3,
		conflicts: 1,
		splits: 1,
		relationsDropped: 1,
	});
	const [c0, c1, c2] = canonicals(t) as [string, string, string];
	const judged = (x: string, y: string) =>
		t.deps.store.read((db) => getPairJudgment(db, x, y));
	expect(judged(c0, c1)).toMatchObject({
		verdict: "conflict",
		resolution: "none",
	});
	expect(judged(c0, c2)).toMatchObject({
		verdict: "condition_split",
		resolution: "split",
	});
	expect(judged(c0, c1)!.aId < judged(c0, c1)!.bId).toBe(true);
	await waitFor(() => resolves.length === 1);
	const [a, b] = [c0, c1].sort() as [string, string];
	expect(resolves[0]).toEqual({ runId, a, b });
	expect(row(t, c2)!.status).toBe("active");
});

test("an old canonical sharing at least half of the members keeps its id and revision moves", async () => {
	const { t, module } = await setup();
	await seedAtoms(t.deps, [mk("atom-01"), mk("atom-02"), mk("atom-03")]);
	await assess(t, ["atom-01", "atom-02", "atom-03"]);
	await seedCluster(t, "c1", ["atom-01", "atom-02", "atom-03"]);
	await t.deps.store.write((db) => {
		upsertKnowledgeItem(db, {
			...atom("old-canon", { title: "Old", body: "Old body" }),
			layer: "canonical",
			situation: "an older situation",
			examples: [{ situation: "s", action: "a", outcome: "o", episodeIds: [] }],
			createdAt: "2026-01-01T00:00:00.000Z",
		});
		replaceKnowledgeEvidence(
			db,
			"old-canon",
			"pipeline",
			["atom-01", "atom-02", "atom-77"].map((id) => ({
				targetKind: "atom" as const,
				targetId: id,
				externalRef: null,
				role: "derived_from" as const,
				quote: `quote ${id}`,
				confidence: null,
			})),
			T0,
		);
	});
	const before = row(t, "old-canon")!;
	t.llm.when(isVerify, autoVerify);
	t.llm.when(isPlan, autoPlan);
	const { runId } = await startRun(t, module);
	const run = await drain(t, runId);
	// {01,02,77} vs {01,02,03}: Jaccard 2/4 = 0.5
	expect(run.counts).toMatchObject({ canonicals: 1, reusedIds: 1 });
	expect(canonicals(t)).toEqual(["old-canon"]);
	const after = row(t, "old-canon")!;
	expect(after.revision).toBeGreaterThan(before.revision);
	expect(after.createdAt).toBe("2026-01-01T00:00:00.000Z");
	expect(after.examples).toHaveLength(1);
	expect(after.situation).not.toBe("an older situation");
	const targets = t.deps.store
		.read((db) => listKnowledgeEvidence(db, "old-canon"))
		.map((e) => e.targetId)
		.sort();
	// the new members, and the earlier derivation that is not a member now
	expect(targets).toEqual(["atom-01", "atom-02", "atom-03", "atom-77"]);
});

test("a canonical with less overlap gets a new id", async () => {
	const { t, module } = await setup();
	await seedAtoms(t.deps, [mk("atom-01"), mk("atom-02"), mk("atom-03")]);
	await assess(t, ["atom-01", "atom-02", "atom-03"]);
	await seedCluster(t, "c1", ["atom-01", "atom-02", "atom-03"]);
	await t.deps.store.write((db) => {
		upsertKnowledgeItem(db, {
			...atom("old-canon"),
			layer: "canonical",
			situation: "an older situation",
		});
		replaceKnowledgeEvidence(
			db,
			"old-canon",
			"pipeline",
			["atom-01", "atom-70", "atom-71", "atom-72"].map((id) => ({
				targetKind: "atom" as const,
				targetId: id,
				externalRef: null,
				role: "derived_from" as const,
				quote: null,
				confidence: null,
			})),
			T0,
		);
	});
	t.llm.when(isVerify, autoVerify);
	t.llm.when(isPlan, autoPlan);
	const { runId } = await startRun(t, module);
	await drain(t, runId);
	const ids = canonicals(t);
	expect(ids).toHaveLength(2);
	expect(ids).toContain("old-canon");
	expect(row(t, "old-canon")!.situation).toBe("an older situation");
});

test("confidence is capped at 0.6 when every member lacks a source, and at 0.95 otherwise", async () => {
	const { t, module } = await setup();
	await seedAtoms(t.deps, [
		mk("atom-01", { confidence: 0.9, provenanceStatus: "source_missing" }),
		mk("atom-02", { confidence: 0.9, provenanceStatus: "source_missing" }),
		mk("atom-11", { confidence: 0.94 }),
		mk("atom-12", { confidence: 0.94 }),
		mk("atom-13", { confidence: 0.94 }),
		mk("atom-14", { confidence: 0.94 }),
	]);
	await assess(t, [
		"atom-01",
		"atom-02",
		"atom-11",
		"atom-12",
		"atom-13",
		"atom-14",
	]);
	await seedCluster(t, "c1", ["atom-01", "atom-02"]);
	await seedCluster(t, "c2", ["atom-11", "atom-12", "atom-13", "atom-14"]);
	t.llm.when(isVerify, autoVerify);
	t.llm.when(isPlan, autoPlan);
	const { runId } = await startRun(t, module);
	await drain(t, runId);
	const [weak, strong] = canonicals(t).map((id) => row(t, id)!);
	expect(weak!.confidence).toBe(0.6);
	expect(weak!.provenanceStatus).toBe("source_missing");
	expect(strong!.confidence).toBe(0.95);
});

test("atoms outside any cluster are distilled eight at a time, one group each", async () => {
	const { t, module } = await setup();
	const ids = Array.from(
		{ length: 10 },
		(_, i) => `atom-${String(i + 1).padStart(2, "0")}`,
	);
	await seedAtoms(
		t.deps,
		ids.map((id) => mk(id)),
	);
	await assess(t, ids);
	// one atom is in a cluster that stands: it is not a single
	await seedAtoms(t.deps, [mk("atom-99")]);
	await assess(t, ["atom-99"]);
	await seedCluster(t, "c1", ["atom-99"]);
	await t.deps.store.write((db) =>
		db
			.query("UPDATE map_clusters SET state = 'distilled' WHERE id = 'c1'")
			.run(),
	);
	// an unassessed atom and a repo_specific one are not singles either
	await seedAtoms(t.deps, [mk("atom-90"), mk("atom-91")]);
	await assess(t, ["atom-91"], "repo_specific");
	t.llm.when(isVerify, autoVerify);
	t.llm.when(isPlan, autoPlan);

	const dry = await module.start("canonical", "run_dry", { dryRun: true });
	expect(dry).toBe(2);
	const { runId, enqueued } = await startRun(t, module);
	expect(enqueued).toBe(2);
	const run = await drain(t, runId);
	expect(run.counts).toMatchObject({ enqueued: 2, settled: 2, canonicals: 10 });
	expect(canonicals(t)).toHaveLength(10);
	const plans = t.llm.calls.filter(isPlan);
	expect(plans).toHaveLength(2);
	expect(promptAtoms(plans[0]!)).toHaveLength(8);
	expect(promptAtoms(plans[1]!)).toHaveLength(2);
	for (const id of ids) expect(row(t, id)!.status).toBe("superseded");
	expect(row(t, "atom-90")!.status).toBe("active");
});

test("limit counts clusters and atoms; the jobs are fed through a window", async () => {
	const { t, module } = await setup();
	const clusterIds: string[] = [];
	for (let i = 0; i < 20; i++) {
		const a = `atom-${String(i).padStart(2, "0")}a`;
		const b = `atom-${String(i).padStart(2, "0")}b`;
		await seedAtoms(t.deps, [mk(a), mk(b)]);
		await assess(t, [a, b]);
		const cid = `c${String(i).padStart(2, "0")}`;
		await seedCluster(t, cid, [a, b]);
		clusterIds.push(cid);
	}
	t.llm.when(isVerify, autoVerify);
	t.llm.when(isPlan, autoPlan);

	const limited = await startRun(t, module, "canonical", { limit: 3 });
	expect(limited.enqueued).toBe(3);
	const first = await drain(t, limited.runId);
	expect(first.counts).toMatchObject({ enqueued: 3, units: 3, canonicals: 3 });
	expect(canonicals(t)).toHaveLength(3);

	// the rest: 17 clusters, more than one window of 16
	const all = await startRun(t, module);
	expect(all.enqueued).toBe(17);
	const second = await drain(t, all.runId);
	expect(second.counts).toMatchObject({
		enqueued: 17,
		settled: 17,
		canonicals: 17,
	});
	expect(canonicals(t)).toHaveLength(20);
	expect(second.state).toBe("completed");
});

test("the canonical stage is refused until the thresholds are calibrated", async () => {
	const { t, module } = await setup({ calibrated: false });
	await expect(startRun(t, module)).rejects.toMatchObject(
		new DistillError("distill_calibration_missing"),
	);
	// the embed stage does not need them
	const embed = await startRun(t, module, "embed");
	expect(embed.enqueued).toBe(1);
	const run = await drain(t, embed.runId);
	expect(run.state).toBe("completed");
});

test("a cluster changed after the job was planned is counted as stale and nothing is written", async () => {
	const { t, module } = await setup();
	await seedAtoms(t.deps, [mk("atom-01"), mk("atom-02")]);
	await assess(t, ["atom-01", "atom-02"]);
	await seedCluster(t, "c1", ["atom-01", "atom-02"]);
	t.llm.when(isVerify, autoVerify);
	t.llm.when(isPlan, autoPlan);
	const { runId } = await startRun(t, module);
	await t.deps.store.write((db) =>
		db
			.query(
				"UPDATE knowledge_items SET status = 'retracted' WHERE id = 'atom-02'",
			)
			.run(),
	);
	const run = await drain(t, runId);
	// the cluster job is stale; atom-01, now in no standing cluster, is distilled alone
	expect(run.counts).toMatchObject({ enqueued: 2, settled: 2, stale: 1 });
	expect(canonicals(t)).toHaveLength(1);
	expect(row(t, "atom-01")!.status).toBe("superseded");
	expect(row(t, "atom-02")!.status).toBe("retracted");
	expect(t.llm.calls.every((c) => !messageText(c).includes("atom-02"))).toBe(
		true,
	);
	// no longer eligible: not left pending for every later run (R1-13)
	expect(run.counts).toMatchObject({ staleCluster: 1 });
	expect(clusterState(t, "c1")).toBe("stale");
});

test("an atom sent to review is not planned again in the same run or the next", async () => {
	const { t, module } = await setup();
	await seedAtoms(t.deps, [mk("atom-01"), mk("atom-02")]);
	await assess(t, ["atom-01", "atom-02"]);
	t.llm.when(isVerify, autoVerify);
	t.llm.when(isPlan, "this is not json");
	const first = await startRun(t, module);
	const run = await drain(t, first.runId);
	expect(run.counts).toMatchObject({ host_rejected: 2, reviews: 2 });
	expect(reviews(t)).toHaveLength(2);
	expect(canonicals(t)).toEqual([]);
	// planner invalid output costs two calls (answer and one repair), once
	expect(t.llm.calls.filter(isPlan)).toHaveLength(2);
	const again = await module.start("canonical", "run_again", { dryRun: true });
	expect(again).toBe(0);
});

test("settle is one transaction: a throw in a later group leaves nothing written", async () => {
	const { t, module } = await setup();
	await seedAtoms(t.deps, [mk("atom-01"), mk("atom-02")]);
	await assess(t, ["atom-01", "atom-02"]);
	t.llm.when(isVerify, autoVerify);
	// the second draft's situation is blank: the schema allows it, the knowledge domain refuses it
	t.llm.when(isPlan, (req: Parameters<typeof messageText>[0]) => {
		const [a1, a2] = promptAtoms(req);
		return plan([
			canonicalGroup(
				[a1!.ref],
				draft([{ text: a1!.body, support: [a1!.ref] }]),
			),
			canonicalGroup(
				[a2!.ref],
				draft([{ text: a2!.body, support: [a2!.ref] }], { situation: "   " }),
			),
		]);
	});
	const { runId } = await startRun(t, module);
	const run = await drain(t, runId);
	const job = t.deps.queue.list({ kind: "distill.canonical" }).items[0]!;
	expect(job.state).toBe("failed");
	expect(job.errorCode).toBe("settle_failed");
	expect(canonicals(t)).toEqual([]);
	expect(row(t, "atom-01")).toMatchObject({
		status: "active",
		retrieval: "searchable",
	});
	expect(
		t.deps.store.read(
			(db) =>
				db.query("SELECT count(*) AS n FROM map_edges").get() as { n: number },
		).n,
	).toBe(0);
	// the failure is counted and the run still ends
	expect(run.counts).toMatchObject({ failed: 1, settled: 1 });
});

test("settleUnit rolls back everything it wrote when the transaction throws", async () => {
	const { t } = await setup();
	await seedAtoms(t.deps, [mk("atom-01")]);
	const atomRow = row(t, "atom-01")!;
	const input: UnitInput = {
		runId: "run_x",
		kind: "singles",
		clusterId: null,
		memberDigest: "d",
		merge: false,
		atoms: [
			{ alias: "a1", row: atomRow, generality: "general", used: 0, notUsed: 0 },
		],
		repoTerms: [],
	};
	const result: UnitResult = {
		groups: [
			{
				kind: "canonical",
				members: ["a1"],
				draft: draft([{ text: text("atom-01"), support: ["a1"] }]) as never,
				plannerCallId: "lc_1",
				verifierCallId: "lc_2",
				polarityTie: false,
				index: 0,
			},
		],
		relations: [],
		relationsDropped: 0,
	};
	await expect(
		t.deps.store.write((db) => {
			settleUnit(
				db,
				t.deps,
				{ runId: "run_x", singles: ["atom-01"] },
				input,
				result,
			);
			throw new Error("boom");
		}),
	).rejects.toThrow("boom");
	expect(canonicals(t)).toEqual([]);
	expect(row(t, "atom-01")!.status).toBe("active");
});

test("an atom changed between the plan and the settle is left alone", async () => {
	const { t } = await setup();
	await seedAtoms(t.deps, [mk("atom-01")]);
	const atomRow = row(t, "atom-01")!;
	await t.deps.store.write((db) =>
		db
			.query(
				"UPDATE knowledge_items SET status = 'retracted' WHERE id = 'atom-01'",
			)
			.run(),
	);
	const input: UnitInput = {
		runId: "run_x",
		kind: "singles",
		clusterId: null,
		memberDigest: "d",
		merge: false,
		atoms: [
			{ alias: "a1", row: atomRow, generality: "general", used: 0, notUsed: 0 },
		],
		repoTerms: [],
	};
	const outcome = await t.deps.store.write((db) =>
		settleUnit(db, t.deps, { runId: "run_x", singles: ["atom-01"] }, input, {
			groups: [
				{
					kind: "canonical",
					members: ["a1"],
					draft: draft([{ text: text("atom-01"), support: ["a1"] }]) as never,
					plannerCallId: "lc_1",
					verifierCallId: "lc_2",
					polarityTie: false,
					index: 0,
				},
			],
			relations: [],
			relationsDropped: 0,
		}),
	);
	expect(outcome.counts).toMatchObject({ staleGroups: 1 });
	expect(canonicals(t)).toEqual([]);
});

test("a polarity tie keeps the canonical and asks the owner (low_confidence)", async () => {
	const { t, module } = await setup();
	await seedAtoms(t.deps, [
		mk("atom-01"),
		mk("atom-02", { polarity: "negative" }),
	]);
	await assess(t, ["atom-01", "atom-02"]);
	await seedCluster(t, "c1", ["atom-01", "atom-02"]);
	t.llm.when(isVerify, verifyJson(1));
	t.llm.when(
		isPlan,
		plan([
			canonicalGroup(
				["a1", "a2"],
				draft([{ text: text("atom-01"), support: ["a1", "a2"] }], {
					polarity: "negative",
				}),
			),
		]),
	);
	const { runId } = await startRun(t, module);
	await drain(t, runId);
	expect(canonicals(t)).toHaveLength(1);
	expect(reviews(t).map((r) => r.kind)).toEqual(["low_confidence"]);
});

test("a draft whose polarity is against the majority is a host violation", async () => {
	const { t, module } = await setup();
	await seedAtoms(t.deps, [mk("atom-01"), mk("atom-02")]);
	await assess(t, ["atom-01", "atom-02"]);
	await seedCluster(t, "c1", ["atom-01", "atom-02"]);
	t.llm.when(isVerify, verifyJson(1));
	t.llm.when(
		isPlan,
		plan([
			canonicalGroup(
				["a1", "a2"],
				draft([{ text: text("atom-01"), support: ["a1", "a2"] }], {
					polarity: "negative",
				}),
			),
		]),
	);
	const { runId } = await startRun(t, module);
	await drain(t, runId);
	expect(canonicals(t)).toEqual([]);
	expect(
		(reviews(t)[0]!.proposal.violations as { code: string }[]).map(
			(v) => v.code,
		),
	).toEqual(["polarity_mismatch"]);
});

test("a busy provider retries the job and writes nothing", async () => {
	const { t, module } = await setup();
	await seedAtoms(t.deps, [mk("atom-01"), mk("atom-02")]);
	await assess(t, ["atom-01", "atom-02"]);
	await seedCluster(t, "c1", ["atom-01", "atom-02"]);
	t.llm.when(isPlan, new LarmError("larm_busy", 1000));
	const { runId } = await startRun(t, module);
	await t.deps.queue.tick();
	await waitFor(
		() =>
			t.deps.queue.list({ kind: "distill.canonical" }).items[0]?.state ===
			"retry_wait",
	);
	expect(canonicals(t)).toEqual([]);
	expect(t.deps.store.read((db) => getRun(db, runId))!.state).toBe("running");
	expect(reviews(t)).toEqual([]);
});

test("the embed stage runs the embedding once and closes its run", async () => {
	let calls = 0;
	const t = createTestDistill({
		embedKnowledge: async () => {
			calls++;
			return {
				owner: "knowledge",
				candidates: 3,
				embedded: 3,
				skipped: 0,
				failed: 0,
				busyWaits: 0,
			};
		},
	});
	ts.push(t);
	const module = createCanonical(t.deps);
	module.registerHandlers();
	expect(await module.start("embed", "run_dry", { dryRun: true })).toBe(1);
	const { runId, enqueued } = await startRun(t, module, "embed");
	expect(enqueued).toBe(1);
	const run = await drain(t, runId);
	expect(run).toMatchObject({ state: "completed", counts: { embedded: 3 } });
	expect(calls).toBe(1);
	await expect(
		module.start("assess", "run_x", { dryRun: false }),
	).rejects.toMatchObject({ code: "invalid_distill_request" });
});

test("a cancelled canonical job closes the run without queueing the embedding", async () => {
	const { t, module } = await setup();
	await seedAtoms(t.deps, [mk("atom-01"), mk("atom-02")]);
	await assess(t, ["atom-01", "atom-02"]);
	await seedCluster(t, "c1", ["atom-01", "atom-02"]);
	const { runId } = await startRun(t, module);
	const job = t.deps.queue.list({ kind: "distill.canonical" }).items[0]!;
	await t.deps.queue.cancel(job.id);
	const run = t.deps.store.read((db) => getRun(db, runId))!;
	expect(run.state).toBe("cancelled");
	expect(t.deps.queue.list({ kind: "distill.embed" }).items).toEqual([]);
});

// ---- review fixes (C1) ------------------------------------------------------------------

test("R1-1: the resolve job of a conflict carries the run id in its dedupe key", async () => {
	const { t, module } = await setup();
	await seedAtoms(t.deps, [
		mk("atom-01"),
		mk("atom-02", {
			body: "Never run a database migration inside a transaction",
		}),
	]);
	await assess(t, ["atom-01", "atom-02"]);
	await seedCluster(t, "c1", ["atom-01", "atom-02"]);
	await t.deps.store.write((db) =>
		db
			.query(
				"UPDATE knowledge_items SET polarity='negative' WHERE id='atom-02'",
			)
			.run(),
	);
	t.llm.when(isVerify, verifyJson(1));
	t.llm.when(
		isPlan,
		plan(
			[
				canonicalGroup(
					["a1"],
					draft([{ text: text("atom-01"), support: ["a1"] }], {
						title: "G one",
					}),
				),
				canonicalGroup(
					["a2"],
					draft(
						[
							{
								text: "Never run a database migration inside a transaction",
								support: ["a2"],
							},
						],
						{ title: "G two", polarity: "negative" },
					),
				),
			],
			[{ a: 0, b: 1, kind: "conflict", note: "opposite" }],
		),
	);
	const { runId } = await startRun(t, module);
	await drain(t, runId);
	const keys = t.deps.store.read((db) =>
		(
			db
				.query(
					"SELECT dedupe_key FROM queue_jobs WHERE kind = 'distill.resolve'",
				)
				.all() as { dedupe_key: string }[]
		).map((r) => r.dedupe_key),
	);
	expect(keys).toHaveLength(1);
	const [a, b] = canonicals(t).sort() as [string, string];
	expect(keys[0]).toMatch(
		new RegExp(`^resolve:${a}:${b}:[0-9a-f]+:[0-9a-f]+:${runId}$`),
	);
});

test("R1-3: a cluster made under allowUnverified is not planned and a planned job refuses it", async () => {
	const { t, module } = await setup();
	await seedAtoms(t.deps, [
		mk("atom-01"),
		mk("atom-02"),
		mk("atom-03"),
		mk("atom-04"),
	]);
	await assess(t, ["atom-01", "atom-02", "atom-03", "atom-04"]);
	await seedCluster(
		t,
		"c1",
		["atom-01", "atom-02"],
		"avglink.v1|t=0.950|unverified",
	);
	await seedCluster(t, "c2", ["atom-03", "atom-04"]);
	t.llm.when(isVerify, autoVerify);
	t.llm.when(isPlan, autoPlan);
	const { runId, enqueued } = await startRun(t, module);
	// only c2 is handed out; the other stays pending and its atoms are not singles
	expect(enqueued).toBe(1);
	await drain(t, runId);
	expect(clusterState(t, "c1")).toBe("pending");
	expect(clusterState(t, "c2")).toBe("distilled");
	expect(row(t, "atom-01")!.status).toBe("active");

	// marked unverified after the job was planned: the job is stale, nothing is written
	await seedCluster(t, "c3", ["atom-01", "atom-02"]);
	const second = await startRun(t, module);
	await t.deps.store.write((db) =>
		db
			.query(
				"UPDATE map_clusters SET algorithm = 'x|unverified' WHERE id = 'c3'",
			)
			.run(),
	);
	const run = await drain(t, second.runId);
	expect(run.counts).toMatchObject({ stale: 1 });
	expect(clusterState(t, "c3")).toBe("pending");
	expect(row(t, "atom-01")!.status).toBe("active");
});

test("R1-8: a planner repo_specific that the assessment does not share goes to the owner", async () => {
	const { t, module } = await setup();
	await seedAtoms(t.deps, [mk("atom-05")]);
	await assess(t, ["atom-05"]);
	t.llm.when(isVerify, autoVerify);
	t.llm.when(
		isPlan,
		plan([{ members: ["a1"], disposition: "repo_specific", canonical: null }]),
	);
	const first = await startRun(t, module);
	const run = await drain(t, first.runId);
	expect(run.counts).toMatchObject({ reviews: 1, generalityReviews: 1 });
	expect(row(t, "atom-05")).toMatchObject({
		status: "active",
		retrieval: "searchable",
	});
	expect(
		t.deps.store.read((db) => getAssessment(db, "knowledge", "atom-05")),
	).toMatchObject({ generality: "general", origin: "llm" });
	const [review] = reviews(t);
	expect(review).toMatchObject({ kind: "generality", state: "open" });
	expect(review!.subject).toMatchObject({
		ownerKind: "knowledge",
		ownerId: "atom-05",
		atomIds: ["atom-05"],
	});
	expect(review!.subject.handles).toHaveLength(1);
	// the same atom is not planned again by the next run
	const plans = t.llm.calls.filter(isPlan).length;
	const second = await startRun(t, module);
	expect(second.enqueued).toBe(0);
	expect(t.llm.calls.filter(isPlan).length).toBe(plans);
});

test("R1-8: repo_specific is confirmed when the assessment already says so", async () => {
	const { t, module } = await setup();
	await seedAtoms(t.deps, [mk("atom-05")]);
	await assess(t, ["atom-05"], "unusable");
	// an unusable assessment is not a single; put the atom in a cluster to reach the planner
	await t.deps.store.write((db) =>
		db
			.query(
				"UPDATE knowledge_items SET retrieval = 'searchable' WHERE id = 'atom-05'",
			)
			.run(),
	);
	await seedAtoms(t.deps, [mk("atom-06")]);
	await assess(t, ["atom-06"]);
	await seedCluster(t, "c1", ["atom-05", "atom-06"]);
	t.llm.when(isVerify, verifyJson(1));
	t.llm.when(
		isPlan,
		plan([
			{ members: ["a1"], disposition: "repo_specific", canonical: null },
			canonicalGroup(
				["a2"],
				draft([{ text: text("atom-06"), support: ["a2"] }]),
			),
		]),
	);
	const { runId } = await startRun(t, module);
	const run = await drain(t, runId);
	expect(run.counts).toMatchObject({
		repo_specific: 1,
		evidenceOnly: 1,
		canonicals: 1,
	});
	expect(row(t, "atom-05")!.retrieval).toBe("evidence_only");
	expect(reviews(t)).toEqual([]);
});

test("R1-9: a flipped negation, or a step the atoms do not hold, is a host violation", async () => {
	const { t, module } = await setup();
	const body =
		"Never run migrations outside a transaction on production databases.";
	await seedAtoms(t.deps, [mk("atom-01", { body, polarity: "negative" })]);
	await assess(t, ["atom-01"]);
	const good = canonicalGroup(
		["a1"],
		draft([{ text: body, support: ["a1"] }], {
			polarity: "negative",
			steps: ["Run migrations outside a transaction"].slice(0, 0),
		}),
	);
	const flipped = canonicalGroup(
		["a1"],
		draft(
			[
				{
					text: "Run migrations outside a transaction on production databases.",
					support: ["a1"],
				},
			],
			{
				polarity: "negative",
				steps: ["Deploy the release to the staging cluster"],
			},
		),
	);
	t.llm.when(isVerify, verifyJson(1));
	t.llm.when(isPlanRepair, plan([good]));
	t.llm.when(isPlan, plan([flipped]));
	const { runId } = await startRun(t, module);
	const run = await drain(t, runId);
	expect(run.counts).toMatchObject({ canonicals: 1 });
	const repair = messageText(t.llm.calls.find(isPlanRepair)!);
	expect(repair).toContain("negation_mismatch (group 0): claim 0");
	expect(repair).toContain("line_unsupported (group 0): steps[0]");
});

test("R1-13: a cluster that stopped being eligible is retired, a merge cluster over 99 atoms goes to the owner", async () => {
	const { t, module } = await setup();
	// c1: a member was retracted after the cluster was built
	await seedAtoms(t.deps, [mk("atom-01"), mk("atom-02")]);
	await assess(t, ["atom-01", "atom-02"]);
	await seedCluster(t, "c1", ["atom-01", "atom-02"]);
	await t.deps.store.write((db) =>
		db
			.query(
				"UPDATE knowledge_items SET status = 'retracted' WHERE id = 'atom-02'",
			)
			.run(),
	);
	// c2: a merge cluster of 100 atoms
	const big = Array.from(
		{ length: 100 },
		(_, i) => `big-${String(i).padStart(3, "0")}`,
	);
	await seedAtoms(
		t.deps,
		big.map((id) => mk(id)),
	);
	await seedCluster(t, "c2", big, MERGE_ALGORITHM);
	t.llm.when(isVerify, autoVerify);
	t.llm.when(isPlan, autoPlan);
	const { runId } = await startRun(t, module);
	const run = await drain(t, runId);
	expect(run.counts).toMatchObject({ staleCluster: 1, reviewOpened: 1 });
	expect(clusterState(t, "c1")).toBe("stale");
	expect(clusterState(t, "c2")).toBe("review");
	const open = reviews(t).filter((r) => r.subject.clusterId === "c2");
	expect(open).toHaveLength(1);
	expect(open[0]).toMatchObject({ kind: "host_rejected" });
	expect(open[0]!.subject).toMatchObject({ reason: "too_many_members" });
	expect(open[0]!.subject.atomIds).toHaveLength(100);
});

test("R1-14: a start whose first window comes out empty reports 0 so the run is not left running", async () => {
	const { t } = await setup();
	await seedAtoms(t.deps, [mk("atom-01"), mk("atom-02")]);
	await assess(t, ["atom-01", "atom-02"]);
	await seedCluster(t, "c1", ["atom-01", "atom-02"]);
	// the cluster is settled by someone else between the read and the write
	const real = t.deps.store;
	const racing = createCanonical({
		...t.deps,
		store: {
			...real,
			read: real.read.bind(real),
			write: ((
				op: Parameters<typeof real.write>[0],
				o?: Parameters<typeof real.write>[1],
			) =>
				real.write((db) => {
					db.query(
						"UPDATE map_clusters SET state = 'distilled' WHERE id = 'c1'",
					).run();
					return op(db);
				}, o)) as typeof real.write,
		},
	});
	const runId = "run_race";
	await t.deps.store.write((db) =>
		createRun(db, { id: runId, stage: "canonical", params: {}, at: T0 }),
	);
	expect(await racing.start("canonical", runId, { dryRun: false })).toBe(0);
	expect(t.deps.queue.list({ kind: "distill.canonical" }).items).toEqual([]);
});

test("R1-11: cancelling a canonical job stops the run: nothing more is fed and no embedding queued", async () => {
	const { t, module } = await setup();
	for (let i = 0; i < 20; i++) {
		const id = `atom-${String(i).padStart(2, "0")}`;
		await seedAtoms(t.deps, [mk(id)]);
		await assess(t, [id]);
		await seedCluster(t, `c${String(i).padStart(2, "0")}`, [id]);
	}
	const { runId, enqueued } = await startRun(t, module);
	expect(enqueued).toBe(20);
	const jobs = t.deps.queue.list({ kind: "distill.canonical" }).items;
	expect(jobs).toHaveLength(16);
	await t.deps.queue.cancel(jobs[0]!.id);
	const run = t.deps.store.read((db) => getRun(db, runId))!;
	expect(run.state).toBe("cancelled");
	expect(run.counts).toMatchObject({ enqueued: 16, settled: 1, cancelled: 1 });
	expect(t.deps.queue.list({ kind: "distill.embed" }).items).toEqual([]);
	// a job that ends afterwards does not feed a cancelled run
	await t.deps.store.write((db) => jobEnded(db, t.deps, runId, {}));
	expect(t.deps.store.read((db) => getRun(db, runId))!.counts.enqueued).toBe(
		16,
	);
});

test("R1-15: a full queue does not roll back the settle that tried to feed it; nothing open fails the run", async () => {
	const { t, module } = await setup();
	for (let i = 0; i < 20; i++) {
		const id = `atom-${String(i).padStart(2, "0")}`;
		await seedAtoms(t.deps, [mk(id)]);
		await assess(t, [id]);
		await seedCluster(t, `c${String(i).padStart(2, "0")}`, [id]);
	}
	const { runId } = await startRun(t, module);
	// fill the scope (128 open jobs) with other work
	await t.deps.store.write((db) => {
		for (let i = 0; i < 112; i++)
			t.deps.queue.enqueueInTransaction(db, {
				scope: "distill",
				kind: "distill.resolve",
				dedupeKey: `fill-${i}`,
				payload: { runId: "other", a: `a${i}`, b: `b${i}` },
				lane: "background",
				maxAttempts: 1,
			});
	});
	await t.deps.store.write((db) => addRunCounts(db, runId, { settled: 9 }));
	// open is now 6: the feed wants 10 more and the queue is full
	await t.deps.store.write((db) =>
		jobEnded(db, t.deps, runId, { canonicals: 1 }),
	);
	let run = t.deps.store.read((db) => getRun(db, runId))!;
	expect(run.state).toBe("running");
	expect(run.counts).toMatchObject({
		settled: 10,
		canonicals: 1,
		feedBlocked: 1,
		enqueued: 16,
	});
	// every open job has ended and the feed is still blocked: the run fails, not hangs
	await t.deps.store.write((db) => addRunCounts(db, runId, { settled: 5 }));
	await t.deps.store.write((db) => jobEnded(db, t.deps, runId, {}));
	run = t.deps.store.read((db) => getRun(db, runId))!;
	expect(run.state).toBe("failed");
});

test("R1-17: an embedding that reports failures fails the run", async () => {
	const { t, module } = await setup();
	t.deps.embedKnowledge = async () => ({
		owner: "knowledge",
		candidates: 3,
		embedded: 1,
		skipped: 0,
		failed: 2,
		busyWaits: 0,
	});
	const { runId } = await startRun(t, module, "embed");
	const run = await drain(t, runId);
	expect(run.state).toBe("failed");
	expect(run.counts).toMatchObject({ embedded: 1, embedFailed: 2 });
});

test("R1-18: repo names in the members' facets stay out of the canonical; a plain value is the latest member's", async () => {
	const { t, module } = await setup();
	await seedAtoms(t.deps, [
		mk("atom-01", {
			facets: {
				technologies: ["sqlite", "nightworkers"],
				owner: "old",
				note: "see src/app/run.ts",
			},
			updatedAt: "2026-10-01T00:00:00.000Z",
		}),
		mk("atom-02", {
			facets: { technologies: ["bun"], owner: "new" },
			updatedAt: "2026-10-02T00:00:00.000Z",
		}),
		mk("atom-09", { scope: "repo", repoKey: "nightworkers" }),
	]);
	await assess(t, ["atom-01", "atom-02"]);
	await seedCluster(t, "c1", ["atom-01", "atom-02"]);
	t.llm.when(isVerify, verifyJson(1));
	t.llm.when(
		isPlan,
		plan([
			canonicalGroup(
				["a1", "a2"],
				draft([{ text: text("atom-01"), support: ["a1", "a2"] }]),
			),
		]),
	);
	const { runId } = await startRun(t, module);
	await drain(t, runId);
	const [id] = canonicals(t);
	expect(row(t, id!)!.facets).toEqual({
		technologies: ["bun", "sqlite"],
		owner: "new",
	});
});

test("R2-2: a personal atom is not planned, as a single or as a cluster member", async () => {
	const { t, module } = await setup();
	await seedAtoms(t.deps, [
		mk("atom-01", { space: "personal" }),
		mk("atom-02"),
		mk("atom-03"),
		mk("atom-04", { space: "personal" }),
	]);
	await assess(t, ["atom-01", "atom-02", "atom-03", "atom-04"]);
	await seedCluster(t, "c1", ["atom-02", "atom-04"]);
	t.llm.when(isVerify, autoVerify);
	t.llm.when(isPlan, autoPlan);
	const { runId } = await startRun(t, module);
	const run = await drain(t, runId);
	// c1 holds a personal atom: retired. atom-03 alone is distilled; atom-01 never is.
	expect(clusterState(t, "c1")).toBe("stale");
	expect(row(t, "atom-01")!.status).toBe("active");
	expect(row(t, "atom-04")!.status).toBe("active");
	expect(run.counts).toMatchObject({ staleCluster: 1 });
	expect(
		t.llm.calls
			.filter(isPlan)
			.every((c) => !messageText(c).includes("atom-01")),
	).toBe(true);
});

test("rule A(c): a cluster is distilled again with atoms its own canonical already absorbed", async () => {
	const { t, module } = await setup();
	await seedAtoms(t.deps, [mk("atom-01"), mk("atom-02")]);
	await assess(t, ["atom-01", "atom-02"]);
	await seedCluster(t, "c1", ["atom-01", "atom-02"]);
	t.llm.when(isVerify, autoVerify);
	t.llm.when(isPlan, autoPlan);
	const first = await startRun(t, module);
	await drain(t, first.runId);
	const [id] = canonicals(t);
	expect(row(t, "atom-01")!.status).toBe("superseded");

	// a late member joins the same cluster, which goes back to pending
	await seedAtoms(t.deps, [mk("atom-03")]);
	await assess(t, ["atom-03"]);
	await seedCluster(t, "c1", ["atom-01", "atom-02", "atom-03"]);
	const second = await startRun(t, module);
	expect(second.enqueued).toBe(1);
	const run = await drain(t, second.runId);
	expect(run.counts).toMatchObject({ canonicals: 1, reusedIds: 1 });
	expect(canonicals(t)).toEqual([id!]);
	expect(row(t, "atom-03")!.status).toBe("superseded");
	expect(
		t.deps.store
			.read((db) => listKnowledgeEvidence(db, id!))
			.map((e) => e.targetId),
	).toEqual(["atom-01", "atom-02", "atom-03"]);
	expect(clusterState(t, "c1")).toBe("distilled");
});

// ---- the owner adopts a held-back draft -------------------------------------------------

/** A cluster whose draft names a repo: held back as host_rejected with the draft in the review. */
async function heldBack() {
	const { t, module } = await setup();
	await seedAtoms(t.deps, [
		mk("atom-01"),
		mk("atom-02"),
		mk("atom-09", { scope: "repo", repoKey: "nightworkers" }),
	]);
	await assess(t, ["atom-01", "atom-02"]);
	await seedCluster(t, "c1", ["atom-01", "atom-02"]);
	t.llm.when(isVerify, verifyJson(1));
	t.llm.when(
		isPlan,
		plan([
			canonicalGroup(
				["a1", "a2"],
				draft([{ text: text("atom-01"), support: ["a1", "a2"] }], {
					title: "How nightworkers runs migrations",
				}),
			),
		]),
	);
	const { runId } = await startRun(t, module);
	await drain(t, runId);
	const [held] = reviews(t);
	const review = createReview(t.deps, { acceptDraft: acceptReviewedDraft });
	return { t, held: held!, review };
}

test("accept on a host_rejected review writes the draft by the rules of the settle", async () => {
	const { t, held, review } = await heldBack();
	expect(held.kind).toBe("host_rejected");
	expect(canonicals(t)).toEqual([]);
	await review.resolveReview(held.id, { kind: "accept" });

	const [id] = canonicals(t);
	expect(row(t, id!)).toMatchObject({
		layer: "canonical",
		status: "active",
		retrieval: "searchable",
		scope: "global",
		title: "How nightworkers runs migrations",
	});
	expect(
		t.deps.store
			.read((db) => listKnowledgeEvidence(db, id!))
			.map((e) => [e.targetId, e.quote]),
	).toEqual([
		["atom-01", text("atom-01")],
		["atom-02", text("atom-01")],
	]);
	for (const a of ["atom-01", "atom-02"])
		expect(row(t, a)).toMatchObject({
			status: "superseded",
			retrieval: "evidence_only",
		});
	expect(clusterState(t, "c1")).toBe("distilled");
	expect(
		t.deps.store.read((db) => listReviews(db, "resolved"))[0],
	).toMatchObject({
		id: held.id,
		resolution: { decision: "accept", canonicalId: id },
	});
	// a second adoption of the same review is refused
	await expect(
		review.resolveReview(held.id, { kind: "accept" }),
	).rejects.toMatchObject({ code: "invalid_distill_request" });
});

test("accept is refused, and nothing written, when an atom changed since the review", async () => {
	const { t, held, review } = await heldBack();
	await t.deps.store.write((db) =>
		upsertKnowledgeItem(db, mk("atom-02", { body: text("atom-02", " more") })),
	);
	await expect(
		review.resolveReview(held.id, { kind: "accept" }),
	).rejects.toMatchObject({ code: "invalid_distill_request" });
	expect(canonicals(t)).toEqual([]);
	expect(row(t, "atom-01")!.status).toBe("active");
	expect(reviews(t)).toHaveLength(1);
});

test("accept is refused for a review that has no draft", async () => {
	const { t, module } = await setup();
	await seedAtoms(t.deps, [mk("atom-01"), mk("atom-02")]);
	await assess(t, ["atom-01", "atom-02"]);
	t.llm.when(isPlan, "not json");
	const { runId } = await startRun(t, module);
	await drain(t, runId);
	const [held] = reviews(t);
	expect(held!.proposal.draft).toBeNull();
	const review = createReview(t.deps, { acceptDraft: acceptReviewedDraft });
	await expect(
		review.resolveReview(held!.id, { kind: "accept" }),
	).rejects.toMatchObject({ code: "invalid_distill_request" });
});

test("accept on verifier_unknown adopts the draft; the cluster closes when no review of it is left", async () => {
	const { t, module } = await setup();
	await seedAtoms(t.deps, [mk("atom-01"), mk("atom-02")]);
	await assess(t, ["atom-01", "atom-02"]);
	await seedCluster(t, "c1", ["atom-01", "atom-02"]);
	t.llm.when(isPlan, autoPlan);
	t.llm.when(
		isVerify,
		verifyJson(2, {
			verdict: "unknown",
			checks: { ...okChecks, exceptions: "unknown" },
		}),
	);
	const { runId } = await startRun(t, module);
	await drain(t, runId);
	const [held] = reviews(t);
	expect(held!.kind).toBe("verifier_unknown");
	expect(clusterState(t, "c1")).toBe("review");
	const review = createReview(t.deps, { acceptDraft: acceptReviewedDraft });
	await review.resolveReview(held!.id, { kind: "accept" });
	expect(canonicals(t)).toHaveLength(1);
	expect(clusterState(t, "c1")).toBe("distilled");
});
