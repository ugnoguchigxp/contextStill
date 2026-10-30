import { afterEach, expect, test } from "bun:test";
import {
	getKnowledgeById,
	listKnowledgeEvidence,
	replaceKnowledgeEvidence,
} from "../../knowledge";
import {
	edgesFrom,
	getCluster,
	memberDigest,
	memberKey,
	upsertCluster,
} from "../../map";
import { DEFAULT_THRESHOLDS } from "../contracts";
import { getPairJudgment, setThresholds } from "../repository";
import { createCanonical } from "../service/canonical";
import { mergeClusterId } from "../service/conflict/apply";
import { createConflict } from "../service/conflict";
import {
	canonical,
	drain,
	isJudgePrompt,
	newRun,
	unit,
	world,
	type World,
} from "../service/conflict/support.test";
import { messageText, T0 } from "./fixtures";

const worlds: World[] = [];
afterEach(async () => {
	for (const w of worlds.splice(0)) await w.dispose();
});

type Req = Parameters<typeof messageText>[0];
const isPlan = (req: Req) =>
	messageText(req).includes("atomic knowledge records into canonical");
const isVerify = (req: Req) => messageText(req).includes("You verify a draft");

const okChecks = {
	conditions: "preserved",
	negation: "preserved",
	exceptions: "preserved",
	numbersAndUnits: "preserved",
	situationFaithful: "preserved",
	noNewMeaning: "preserved",
	noRepoSpecifics: "preserved",
};

interface PromptAtom {
	ref: string;
	body: string;
}
const promptAtoms = (req: Req): PromptAtom[] => {
	const m = /Atoms \(JSON\):\n(\[[^\n]*\])/.exec(messageText(req));
	return m ? (JSON.parse(m[1]!) as PromptAtom[]) : [];
};

/** The merged canonical: one group of all atoms, each claim copied from its atom. */
function planAll(req: Req) {
	const atoms = promptAtoms(req);
	return {
		schemaVersion: 1,
		groups: [
			{
				members: atoms.map((a) => a.ref),
				disposition: "canonical",
				canonical: {
					type: "rule",
					polarity: "positive",
					title: "Merged guidance",
					situation: "When the same guidance was recorded twice",
					guidance: atoms.map((a) => a.body).join(" "),
					rationale: "",
					appliesWhen: [],
					notAppliesWhen: [],
					steps: [],
					exceptions: [],
					claims: atoms.map((a) => ({ text: a.body, support: [a.ref] })),
				},
			},
		],
		relations: [],
	};
}
function verifyAll(req: Req) {
	const m = /Draft \(JSON\):\n([^\n]*)/.exec(messageText(req));
	const n = (JSON.parse(m![1]!) as { claims: unknown[] }).claims.length;
	return {
		schemaVersion: 1,
		verdict: "supported",
		claims: Array.from({ length: n }, (_, index) => ({
			index,
			entailed: "yes",
		})),
		checks: okChecks,
		rationale: "ok",
	};
}
const duplicate = (req: Req) => ({
	schemaVersion: 1,
	pairs: Array.from(
		{ length: (messageText(req).match(/### Pair \d+/g) ?? []).length },
		(_, index) => ({
			index,
			verdict: "duplicate",
			aNotAppliesWhen: [],
			bNotAppliesWhen: [],
			note: "",
		}),
	),
});

/**
 * duplicate judged -> resolve -> merge cluster -> canonical stage -> conflict stage again
 * (reconcileMerges). `ghosts` extra atoms in the evidence of each old canonical make the
 * overlap with the merged members too small for the id to be kept.
 */
async function mergeFlow(ghosts: number) {
	const w = await world();
	worlds.push(w);
	const deps = w.deps;
	await deps.store.write((db) =>
		setThresholds(db, { ...DEFAULT_THRESHOLDS, calibratedAt: T0 }, T0),
	);
	const conflict = createConflict(deps);
	conflict.registerHandlers();
	const canon = createCanonical(deps);
	canon.registerHandlers();
	w.llm.when(isJudgePrompt, duplicate);
	w.llm.when(isPlan, planAll);
	w.llm.when(isVerify, verifyAll);

	const sims = [unit(1, 0, 0), unit(0.99, 0.1, 0)] as const;
	for (const [i, id] of ["c1", "c2"].entries()) {
		const atoms = await canonical(deps, { id, vec: sims[i], atoms: 2 });
		if (ghosts > 0)
			await deps.store.write((db) =>
				replaceKnowledgeEvidence(
					db,
					id,
					"pipeline",
					[
						...atoms,
						...Array.from({ length: ghosts }, (_, k) => `${id}-ghost${k}`),
					].map((targetId) => ({
						targetKind: "atom" as const,
						targetId,
						externalRef: null,
						role: "derived_from" as const,
						quote: null,
						confidence: null,
					})),
					T0,
				),
			);
	}

	// 1. the pair is judged duplicate and resolved: a pending merge cluster of the four atoms
	await newRun(deps, "r1");
	await conflict.start("conflict", "r1", { dryRun: false });
	await drain(deps);
	const clusterId = mergeClusterId("c1", "c2");
	expect(deps.store.read((db) => getCluster(db, clusterId))).toMatchObject({
		state: "pending",
		algorithm: "conflict-merge-v1",
	});

	// 2. the canonical stage distills it although its atoms are already superseded
	await newRun(deps, "r2", "canonical");
	expect(await canon.start("canonical", "r2", { dryRun: false })).toBe(1);
	await drain(deps);
	expect(deps.store.read((db) => getCluster(db, clusterId))!.state).toBe(
		"distilled",
	);

	// 3. the conflict stage finishes the merge
	await newRun(deps, "r3");
	await conflict.start("conflict", "r3", { dryRun: false });
	await drain(deps);
	return { deps, clusterId };
}

const status = (w: World["deps"], id: string) =>
	w.store.read((db) => {
		const r = getKnowledgeById(db, id)!;
		return { status: r.status, retrieval: r.retrieval };
	});
const activeCanonicals = (deps: World["deps"]) =>
	deps.store
		.read(
			(db) =>
				db
					.query(
						`SELECT id FROM knowledge_items WHERE layer = 'canonical'
						 AND status = 'active' AND retrieval = 'searchable' ORDER BY id`,
					)
					.all() as { id: string }[],
		)
		.map((r) => r.id);

test("a merge cluster is distilled and the new canonical, keeping the id of c1, replaces c2", async () => {
	const { deps, clusterId } = await mergeFlow(0);
	expect(activeCanonicals(deps)).toEqual(["c1"]);
	expect(status(deps, "c2")).toEqual({
		status: "superseded",
		retrieval: "evidence_only",
	});
	// c1 was rewritten in place from the four atoms
	const c1 = deps.store.read((db) => getKnowledgeById(db, "c1")!);
	expect(c1.title).toBe("Merged guidance");
	expect(c1.metadata.distill).toMatchObject({ clusterId });
	expect(
		deps.store
			.read((db) => listKnowledgeEvidence(db, "c1"))
			.map((e) => e.targetId)
			.sort(),
	).toEqual(["c1-a1", "c1-a2", "c2-a1", "c2-a2"]);
	expect(
		deps.store
			.read((db) => edgesFrom(db, "knowledge", "c1", "supersedes"))
			.map((e) => e.dst.id)
			.sort(),
	).toEqual(["c1-a1", "c1-a2", "c2", "c2-a1", "c2-a2"]);
	expect(
		deps.store.read((db) => getPairJudgment(db, "c1", "c2")),
	).toMatchObject({ verdict: "duplicate", resolution: "merged" });
	// the absorbed atoms stay out of search
	for (const a of ["c1-a1", "c1-a2", "c2-a1", "c2-a2"])
		expect(status(deps, a)).toEqual({
			status: "superseded",
			retrieval: "evidence_only",
		});
});

test("a merge cluster with a new canonical id supersedes both old canonicals", async () => {
	const { deps } = await mergeFlow(6);
	const active = activeCanonicals(deps);
	expect(active).toHaveLength(1);
	expect(active[0]).not.toBe("c1");
	expect(active[0]).not.toBe("c2");
	for (const old of ["c1", "c2"])
		expect(status(deps, old)).toEqual({
			status: "superseded",
			retrieval: "evidence_only",
		});
	const edges = deps.store
		.read((db) => edgesFrom(db, "knowledge", active[0]!, "supersedes"))
		.map((e) => e.dst.id)
		.sort();
	expect(edges).toEqual(["c1", "c1-a1", "c1-a2", "c2", "c2-a1", "c2-a2"]);
	expect(
		deps.store.read((db) => getPairJudgment(db, "c1", "c2")),
	).toMatchObject({ resolution: "merged" });
});

test("an ordinary cluster still refuses an atom that was already absorbed", async () => {
	const w = await world();
	worlds.push(w);
	const deps = w.deps;
	await deps.store.write((db) =>
		setThresholds(db, { ...DEFAULT_THRESHOLDS, calibratedAt: T0 }, T0),
	);
	const canon = createCanonical(deps);
	canon.registerHandlers();
	w.llm.when(isPlan, planAll);
	w.llm.when(isVerify, verifyAll);
	// c1's atoms are superseded; only a merge cluster may be made of them
	const atoms = await canonical(deps, { id: "c1", atoms: 2 });
	await deps.store.write((db) => {
		const members = atoms.map((id) => ({
			kind: "knowledge" as const,
			id,
			role: "member" as const,
			similarity: 0.95,
		}));
		const digests = new Map(
			atoms.map((id) => [
				memberKey("knowledge", id),
				getKnowledgeById(db, id)!.contentDigest,
			]),
		);
		upsertCluster(db, {
			id: "cl-plain",
			kind: "claim",
			parentId: null,
			level: 0,
			name: "",
			aliases: [],
			description: "",
			summary: {},
			state: "pending",
			algorithm: "avglink.v1",
			memberDigest: memberDigest(members, digests),
			members,
			createdAt: T0,
			updatedAt: T0,
		});
	});
	await newRun(deps, "r1", "canonical");
	await canon.start("canonical", "r1", { dryRun: false });
	await drain(deps);
	expect(w.llm.calls).toHaveLength(0);
	// it can never be distilled as it is: it is retired, not left pending (R1-13)
	expect(deps.store.read((db) => getCluster(db, "cl-plain"))!.state).toBe(
		"stale",
	);
	expect(activeCanonicals(deps)).toEqual(["c1"]);
});
