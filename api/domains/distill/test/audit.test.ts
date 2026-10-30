import { afterEach, expect, test } from "bun:test";
import { replaceKnowledgeEvidence, upsertKnowledgeItem } from "../../knowledge";
import type { AuditCode, PairJudgmentRow } from "../contracts";
import { upsertPairJudgment } from "../repository";
import { createAudit, resampleJudgments } from "../service/audit";
import { scanCandidates } from "../service/conflict/candidates";
import {
	canonical,
	isJudgePrompt,
	SPACE_KEY,
	unit,
	world,
	type World,
} from "../service/conflict/support.test";
import { atom, messageText, T0 } from "./fixtures";

const worlds: World[] = [];
afterEach(async () => {
	for (const w of worlds.splice(0)) await w.dispose();
});
async function setup() {
	const w = await world();
	worlds.push(w);
	return { w, deps: w.deps, audit: createAudit(w.deps) };
}
const codes = (r: { violations: { code: AuditCode }[] }) =>
	r.violations.map((v) => v.code);

/** Two healthy canonicals: far apart, with vectors, atoms that are superseded. */
async function clean(deps: World["deps"]) {
	await canonical(deps, { id: "c1", vec: unit(1, 0, 0) });
	await canonical(deps, { id: "c2", vec: unit(0, 1, 0) });
}

function judge(
	deps: World["deps"],
	over: Partial<Omit<PairJudgmentRow, "createdAt" | "updatedAt">> = {},
) {
	return deps.store.write((db) => {
		const pair = scanCandidates(db, SPACE_KEY, 0).pairs[0]!;
		upsertPairJudgment(db, {
			aId: "c1",
			bId: "c2",
			aDigest: pair.aDigest,
			bDigest: pair.bDigest,
			verdict: "compatible",
			resolution: "none",
			detail: {},
			callId: null,
			at: T0,
			...over,
		});
	});
}

test("a healthy set passes with every check counted", async () => {
	const { deps, audit } = await setup();
	await clean(deps);
	const r = audit.audit();
	expect(r).toMatchObject({ ok: true, violations: [] });
	expect(r.checked).toMatchObject({
		unresolved_conflict: 2,
		citation_invalid: 2,
		generalization_lint: 2,
		canonical_without_vector: 2,
		repo_scope_canonical: 2,
		active_atom_absorbed: 4,
		superseded_without_target: 4,
	});
});

test("unresolved_conflict: unresolved conflict or unknown between active canonicals; a decided one is not", async () => {
	const { deps, audit } = await setup();
	await clean(deps);
	await judge(deps, { verdict: "unknown", resolution: "owner_pending" });
	expect(audit.audit().violations).toEqual([
		{ code: "unresolved_conflict", subject: ["c1", "c2"] },
	]);
	await judge(deps, { verdict: "conflict", resolution: "none" });
	expect(codes(audit.audit())).toEqual(["unresolved_conflict"]);
	for (const resolution of ["a_wins", "b_wins", "owner_resolved"] as const) {
		await judge(deps, { verdict: "conflict", resolution });
		expect(audit.audit().ok).toBe(true);
	}
	// compatible is never a conflict, whatever the resolution
	await judge(deps, { verdict: "compatible", resolution: "none" });
	expect(audit.audit().ok).toBe(true);
	// a conflict with a side that is no longer active is not between active canonicals
	await judge(deps, { verdict: "conflict", resolution: "none" });
	await deps.store.write((db) =>
		db
			.query("UPDATE knowledge_items SET status = 'retracted' WHERE id = 'c2'")
			.run(),
	);
	expect(codes(audit.audit())).not.toContain("unresolved_conflict");
});

test("unjudged_near_pair: a near pair needs a judgment of its current texts", async () => {
	const { deps, audit } = await setup();
	await canonical(deps, { id: "c1", vec: unit(1, 0, 0) });
	await canonical(deps, { id: "c2", vec: unit(1, 0.05, 0) });
	expect(audit.audit().violations).toEqual([
		{ code: "unjudged_near_pair", subject: ["c1", "c2"] },
	]);
	await judge(deps, { aDigest: "stale" });
	expect(codes(audit.audit())).toEqual(["unjudged_near_pair"]);
	await judge(deps);
	expect(audit.audit().ok).toBe(true);
});

test("citation_invalid: no atoms to cite, a missing atom, a claim the atoms do not carry", async () => {
	const { deps, audit } = await setup();
	const cited = () =>
		audit.audit().violations.filter((v) => v.code === "citation_invalid");
	await canonical(deps, { id: "c1", vec: unit(1, 0, 0), atoms: 0 });
	await canonical(deps, { id: "c2", vec: unit(0, 1, 0), atoms: 1 });
	await canonical(deps, { id: "c3", vec: unit(0, 0, 1), atoms: 1 });
	expect(cited()).toEqual([{ code: "citation_invalid", subject: ["c1"] }]);

	await deps.store.write((db) => {
		upsertKnowledgeItem(
			db,
			atom("q1", {
				title: "retry policy",
				body: "retry the request three times with exponential backoff",
				status: "superseded",
			}),
		);
		const ev = (quote: string | null, id = "q1") => [
			{
				targetKind: "atom" as const,
				targetId: id,
				externalRef: null,
				role: "derived_from" as const,
				quote,
				confidence: null,
			},
		];
		replaceKnowledgeEvidence(
			db,
			"c2",
			"pipeline",
			ev("retry the request with exponential backoff"),
			T0,
		);
		replaceKnowledgeEvidence(
			db,
			"c3",
			"pipeline",
			ev("retry the request 99 times with exponential backoff"),
			T0,
		);
	});
	// c2's claim is in the atom; c3's "99" is not
	expect(cited()).toEqual([
		{ code: "citation_invalid", subject: ["c1"] },
		{ code: "citation_invalid", subject: ["c3"] },
	]);

	await deps.store.write((db) =>
		replaceKnowledgeEvidence(
			db,
			"c2",
			"pipeline",
			[
				{
					targetKind: "atom",
					targetId: "ghost",
					externalRef: null,
					role: "derived_from",
					quote: null,
					confidence: null,
				},
			],
			T0,
		),
	);
	expect(cited().map((v) => v.subject[0])).toContain("c2");
});

test("generalization_lint: an absolute path, a port or a repo name in a canonical", async () => {
	const { deps, audit } = await setup();
	await clean(deps);
	expect(audit.audit().ok).toBe(true);
	await deps.store.write((db) => {
		upsertKnowledgeItem(
			db,
			atom("r1", { scope: "repo", repoKey: "nightworkers" }),
		);
	});
	await canonical(deps, {
		id: "p1",
		vec: null,
		over: { body: "open /Users/me/proj/src/a.ts and start it" },
	});
	await canonical(deps, {
		id: "p2",
		vec: null,
		over: { situation: "when nightworkers fails" },
	});
	await canonical(deps, {
		id: "p3",
		vec: null,
		over: { steps: ["curl localhost:3000"] },
	});
	const lint = audit
		.audit()
		.violations.filter((v) => v.code === "generalization_lint")
		.map((v) => v.subject[0]);
	expect(lint).toEqual(["p1", "p2", "p3"]);
});

test("superseded_without_target: a superseded atom must lead to an active or superseded canonical", async () => {
	const { deps, audit } = await setup();
	await clean(deps);
	await deps.store.write((db) =>
		upsertKnowledgeItem(db, atom("orphan", { status: "superseded" })),
	);
	expect(audit.audit().violations).toEqual([
		{ code: "superseded_without_target", subject: ["orphan"] },
	]);
	// a retracted canonical is not a target
	await deps.store.write((db) => {
		replaceKnowledgeEvidence(
			db,
			"c1",
			"human",
			[
				{
					targetKind: "atom",
					targetId: "orphan",
					externalRef: null,
					role: "derived_from",
					quote: null,
					confidence: null,
				},
			],
			T0,
		);
		db.query(
			"UPDATE knowledge_items SET status = 'retracted' WHERE id = 'c1'",
		).run();
	});
	expect(codes(audit.audit())).toContain("superseded_without_target");
	await deps.store.write((db) =>
		db
			.query("UPDATE knowledge_items SET status = 'superseded' WHERE id = 'c1'")
			.run(),
	);
	expect(
		audit
			.audit()
			.violations.filter((v) => v.code === "superseded_without_target"),
	).toEqual([]);
});

test("active_atom_absorbed: no atom under an active canonical may stay active", async () => {
	const { deps, audit } = await setup();
	await canonical(deps, {
		id: "c1",
		vec: unit(1, 0, 0),
		atomStatus: "active",
		atoms: 1,
	});
	await canonical(deps, { id: "c2", vec: unit(0, 1, 0) });
	expect(audit.audit().violations).toEqual([
		{ code: "active_atom_absorbed", subject: ["c1-a1", "c1"] },
	]);
});

test("canonical_without_vector: a missing vector, or one made from other text", async () => {
	const { deps, audit } = await setup();
	await canonical(deps, { id: "c1", vec: null });
	await canonical(deps, { id: "c2", vec: unit(0, 1, 0) });
	expect(audit.audit().violations).toEqual([
		{ code: "canonical_without_vector", subject: ["c1"] },
	]);
	await deps.store.write((db) =>
		db
			.query("UPDATE vectors SET content_digest = 'old' WHERE owner_id = 'c2'")
			.run(),
	);
	expect(audit.audit().violations.map((v) => v.subject[0])).toEqual([
		"c1",
		"c2",
	]);
});

test("repo_scope_canonical: an active canonical must be global", async () => {
	const { deps, audit } = await setup();
	await canonical(deps, {
		id: "c1",
		vec: unit(1, 0, 0),
		over: { scope: "repo", repoKey: "someplace" },
	});
	await canonical(deps, { id: "c2", vec: unit(0, 1, 0) });
	expect(audit.audit().violations).toEqual([
		{ code: "repo_scope_canonical", subject: ["c1"] },
	]);
});

test("the spot check judges again with another prompt and reports the agreement on conflict", async () => {
	const { w, deps } = await setup();
	await canonical(deps, { id: "c1", vec: unit(1, 0, 0) });
	await canonical(deps, { id: "c2", vec: unit(1, 0.05, 0) });
	expect(await resampleJudgments(deps)).toEqual({
		sampled: 0,
		conflictBefore: 0,
		conflictAgreed: 0,
		conflictAgreement: null,
	});
	await judge(deps, { verdict: "conflict", resolution: "owner_pending" });
	const answer = (verdict: string) => () => ({
		schemaVersion: 1,
		pairs: [
			{
				index: 0,
				verdict,
				aNotAppliesWhen: [],
				bNotAppliesWhen: [],
				note: "",
			},
		],
	});
	w.llm.when(isJudgePrompt, answer("conflict"));
	expect(await resampleJudgments(deps)).toEqual({
		sampled: 1,
		conflictBefore: 1,
		conflictAgreed: 1,
		conflictAgreement: 1,
	});
	// the second pass really used the other wording
	expect(messageText(w.llm.calls[0]!)).toContain("audit a knowledge base");
	const second = await world();
	worlds.push(second);
	await canonical(second.deps, { id: "c1", vec: unit(1, 0, 0) });
	await canonical(second.deps, { id: "c2", vec: unit(1, 0.05, 0) });
	await judge(second.deps, {
		verdict: "conflict",
		resolution: "owner_pending",
	});
	second.llm.when(isJudgePrompt, answer("compatible"));
	expect((await resampleJudgments(second.deps)).conflictAgreement).toBe(0);
});

test("R1-10: the yielding audit gives the report of the synchronous one and lets the event loop run", async () => {
	const { deps, audit } = await setup();
	for (let i = 0; i < 12; i++)
		await canonical(deps, {
			id: `K${String(i).padStart(2, "0")}`,
			vec: unit(Math.cos(i), Math.sin(i), 0.3),
		});
	const sync = audit.audit();
	let ticks = 0;
	let stop = false;
	const spin = () => {
		ticks++;
		if (!stop) setImmediate(spin);
	};
	setImmediate(spin);
	const yielded = await audit.auditYielding();
	stop = true;
	expect(ticks).toBeGreaterThan(5);
	expect(yielded).toEqual(sync);
});
