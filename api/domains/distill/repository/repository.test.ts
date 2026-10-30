import { afterEach, expect, test } from "bun:test";
import { DEFAULT_THRESHOLDS } from "../contracts";
import { createTestDistill, T0 } from "../test/fixtures";
import {
	addRunCounts,
	countAssessmentsByGenerality,
	countOpenReviewsByKind,
	createRun,
	findOkCallByDigest,
	findRunningRun,
	finishRun,
	getAssessment,
	getLlmCall,
	getParam,
	getPairJudgment,
	getReview,
	getRun,
	getThresholds,
	insertLlmCall,
	insertReview,
	listAssessments,
	listPairJudgments,
	listReviews,
	llmCallTotals,
	pruneFailedLlmCalls,
	setPairResolution,
	setParam,
	setThresholds,
	settleReview,
	upsertAssessment,
	upsertPairJudgment,
	MAX_RESPONSE_BYTES,
} from "./index";

const ts: ReturnType<typeof createTestDistill>[] = [];
afterEach(async () => {
	for (const t of ts.splice(0)) await t.dispose();
});
const setup = () => {
	const t = createTestDistill();
	ts.push(t);
	return t.deps.store;
};
const T1 = "2026-10-30T01:00:00.000Z";

const assessment = (over = {}) => ({
	ownerKind: "knowledge" as const,
	ownerId: "k1",
	generality: "general" as const,
	signals: { absolutePaths: [] },
	reason: "",
	origin: "llm" as const,
	contentDigest: "d1",
	promptVersion: "assess.v1",
	callId: null,
	at: T0,
	...over,
});

test("assessments: one row per owner, an equal write changes nothing", async () => {
	const store = setup();
	expect(await store.write((db) => upsertAssessment(db, assessment()))).toBe(
		"inserted",
	);
	expect(
		await store.write((db) => upsertAssessment(db, assessment({ at: T1 }))),
	).toBe("unchanged");
	expect(
		await store.write((db) =>
			upsertAssessment(db, assessment({ generality: "repo_specific", at: T1 })),
		),
	).toBe("updated");
	await store.write((db) =>
		upsertAssessment(db, assessment({ ownerId: "k2", generality: "unusable" })),
	);
	await store.write((db) =>
		upsertAssessment(db, assessment({ ownerKind: "episode", ownerId: "e1" })),
	);
	const row = store.read((db) => getAssessment(db, "knowledge", "k1"))!;
	expect(row).toMatchObject({
		generality: "repo_specific",
		createdAt: T0,
		updatedAt: T1,
		signals: { absolutePaths: [] },
	});
	expect(
		store.read((db) => countAssessmentsByGenerality(db, "knowledge")),
	).toEqual({
		general: 0,
		generalizable: 0,
		repo_specific: 1,
		unusable: 1,
	});
	expect(
		store
			.read((db) => listAssessments(db, { ownerKind: "episode" }))
			.map((a) => a.ownerId),
	).toEqual(["e1"]);
	expect(store.read((db) => getAssessment(db, "knowledge", "none"))).toBeNull();
});

test("params and thresholds: defaults until calibrated", async () => {
	const store = setup();
	expect(store.read((db) => getParam(db, "x"))).toBeNull();
	expect(store.read(getThresholds)).toEqual(DEFAULT_THRESHOLDS);
	expect(DEFAULT_THRESHOLDS.calibratedAt).toBeNull();
	await store.write((db) => setParam(db, "x", { a: [1] }, T0));
	expect(store.read((db) => getParam<{ a: number[] }>(db, "x"))).toEqual({
		a: [1],
	});
	const calibrated = {
		...DEFAULT_THRESHOLDS,
		clusterEdge: 0.95,
		calibratedAt: T1,
	};
	await store.write((db) => setThresholds(db, calibrated, T1));
	expect(store.read(getThresholds)).toEqual(calibrated);
});

test("runs: running per stage, counters add up, finishing is once", async () => {
	const store = setup();
	await store.write((db) =>
		createRun(db, { id: "r1", stage: "assess", params: { limit: 5 }, at: T0 }),
	);
	expect(store.read((db) => findRunningRun(db, "assess"))!.id).toBe("r1");
	expect(store.read((db) => findRunningRun(db, "cluster"))).toBeNull();
	await store.write((db) => addRunCounts(db, "r1", { done: 2, failed: 1 }));
	await store.write((db) => addRunCounts(db, "r1", { done: 3 }));
	expect(store.read((db) => getRun(db, "r1"))).toMatchObject({
		counts: { done: 5, failed: 1 },
		params: { limit: 5 },
		state: "running",
	});
	expect(await store.write((db) => finishRun(db, "r1", "completed", T1))).toBe(
		true,
	);
	expect(await store.write((db) => finishRun(db, "r1", "failed", T1))).toBe(
		false,
	);
	expect(store.read((db) => findRunningRun(db, "assess"))).toBeNull();
	expect(store.read((db) => getRun(db, "r1"))).toMatchObject({
		state: "completed",
		finishedAt: T1,
	});
	expect(await store.write((db) => addRunCounts(db, "none", { done: 1 }))).toBe(
		false,
	);
});

const call = (over = {}) => ({
	id: "lc_1",
	runId: null,
	stage: "assess" as const,
	subjectRef: "k1",
	provider: "fixture",
	model: "m",
	promptVersion: "p1",
	inputDigest: "dig",
	inputTokens: 10,
	outputTokens: 5,
	latencyMs: 12,
	outcome: "ok" as const,
	response: { a: 1 },
	at: T0,
	...over,
});

test("llm calls: the newest ok answer for a digest is found; failures and oversize answers are not", async () => {
	const store = setup();
	await store.write((db) => {
		insertLlmCall(
			db,
			call({
				id: "lc_bad",
				outcome: "invalid_output",
				response: { bad: true },
			}),
		);
		insertLlmCall(
			db,
			call({
				id: "lc_err",
				outcome: "provider_error",
				response: null,
				inputTokens: null,
				outputTokens: null,
			}),
		);
		insertLlmCall(db, call({ id: "lc_old", response: { v: 1 }, at: T0 }));
		insertLlmCall(db, call({ id: "lc_new", response: { v: 2 }, at: T1 }));
		insertLlmCall(
			db,
			call({
				id: "lc_big",
				inputDigest: "big",
				response: { text: "x".repeat(MAX_RESPONSE_BYTES) },
			}),
		);
	});
	expect(store.read((db) => findOkCallByDigest(db, "dig"))!.id).toBe("lc_new");
	expect(store.read((db) => findOkCallByDigest(db, "dig"))!.response).toEqual({
		v: 2,
	});
	expect(store.read((db) => findOkCallByDigest(db, "other"))).toBeNull();
	expect(store.read((db) => getLlmCall(db, "lc_big"))!.response).toBeNull();
	expect(store.read((db) => findOkCallByDigest(db, "big"))).toBeNull();
	expect(store.read(llmCallTotals)).toEqual({
		calls: 5,
		inputTokens: 40,
		outputTokens: 20,
		invalidOutput: 1,
	});
});

test("llm calls: pruning deletes only failed calls older than the cutoff", async () => {
	const store = setup();
	await store.write((db) => {
		insertLlmCall(
			db,
			call({ id: "lc_bad_old", outcome: "invalid_output", at: T0 }),
		);
		insertLlmCall(
			db,
			call({
				id: "lc_err_new",
				outcome: "provider_error",
				response: null,
				at: T1,
			}),
		);
		insertLlmCall(db, call({ id: "lc_ok_old", response: { v: 1 }, at: T0 }));
	});
	expect(await store.write((db) => pruneFailedLlmCalls(db, T1))).toBe(1);
	expect(store.read((db) => getLlmCall(db, "lc_bad_old"))).toBeNull();
	expect(store.read((db) => getLlmCall(db, "lc_err_new"))).not.toBeNull();
	expect(store.read((db) => getLlmCall(db, "lc_ok_old"))).not.toBeNull();
});

const pair = (over = {}) => ({
	aId: "b",
	bId: "a",
	aDigest: "db",
	bDigest: "da",
	verdict: "conflict" as const,
	resolution: "owner_pending" as const,
	detail: { note: "x" },
	callId: null,
	at: T0,
	...over,
});

test("pair judgments are stored with a_id < b_id, sides and digests swapped together", async () => {
	const store = setup();
	expect(await store.write((db) => upsertPairJudgment(db, pair()))).toBe(
		"inserted",
	);
	const row = store.read((db) => getPairJudgment(db, "b", "a"))!;
	expect(row).toMatchObject({
		aId: "a",
		bId: "b",
		aDigest: "da",
		bDigest: "db",
		verdict: "conflict",
	});
	expect(store.read((db) => getPairJudgment(db, "a", "b"))).toEqual(row);
	// the same pair given the other way round is the same row
	expect(
		await store.write((db) =>
			upsertPairJudgment(
				db,
				pair({ aId: "a", bId: "b", aDigest: "da", bDigest: "db", at: T1 }),
			),
		),
	).toBe("unchanged");
	expect(
		await store.write((db) => setPairResolution(db, "b", "a", "a_wins", T1)),
	).toBe(true);
	expect(
		await store.write((db) => setPairResolution(db, "a", "b", "a_wins", T1)),
	).toBe(false);
	expect(
		store.read((db) => listPairJudgments(db, { resolution: "a_wins" })).length,
	).toBe(1);
	expect(
		store.read((db) => listPairJudgments(db, { verdict: "duplicate" })),
	).toEqual([]);
	await expect(
		store.write((db) => upsertPairJudgment(db, pair({ aId: "x", bId: "x" }))),
	).rejects.toThrow("invalid_pair");
});

test("reviews: a subject opens one review; settling is once; open ones are counted by kind", async () => {
	const store = setup();
	const open = (id: string, kind: "conflict" | "host_rejected" = "conflict") =>
		store.write((db) =>
			insertReview(db, {
				id,
				kind,
				subject: { a: "x" },
				proposal: { p: 1 },
				at: T0,
			}),
		);
	expect(await open("rv1")).toBe(true);
	expect(await open("rv1")).toBe(false);
	await open("rv2", "host_rejected");
	expect(store.read((db) => countOpenReviewsByKind(db))).toEqual({
		conflict: 1,
		low_confidence: 0,
		generality: 0,
		verifier_unknown: 0,
		host_rejected: 1,
	});
	expect(store.read((db) => getReview(db, "rv1"))).toMatchObject({
		state: "open",
		subject: { a: "x" },
		proposal: { p: 1 },
		resolution: null,
	});
	expect(
		await store.write((db) =>
			settleReview(db, "rv1", "resolved", { kind: "a_wins" }, T1),
		),
	).toBe(true);
	expect(
		await store.write((db) => settleReview(db, "rv1", "dismissed", null, T1)),
	).toBe(false);
	// a settled review is not opened again by a re-run
	expect(await open("rv1")).toBe(false);
	expect(store.read((db) => getReview(db, "rv1"))).toMatchObject({
		state: "resolved",
		resolution: { kind: "a_wins" },
		resolvedAt: T1,
	});
	expect(store.read((db) => listReviews(db, "open")).map((r) => r.id)).toEqual([
		"rv2",
	]);
	expect(store.read((db) => listReviews(db, "open", "conflict"))).toEqual([]);
	expect(store.read((db) => listReviews(db, "resolved")).length).toBe(1);
});
