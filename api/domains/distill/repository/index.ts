import type { Database } from "bun:sqlite";
import { canonicalJson } from "../../../infrastructure/digest";
import type { UpsertResult } from "../../../infrastructure/scope";
import { upsertRow } from "../../../infrastructure/sqlite/upsert";
import {
	DEFAULT_THRESHOLDS,
	type AssessmentInput,
	type AssessmentRow,
	type DistillStage,
	type Generality,
	type LlmCallInput,
	type LlmCallRow,
	type OwnerKind,
	type PairJudgmentInput,
	type PairJudgmentRow,
	type ReviewInput,
	type ReviewKind,
	type ReviewRow,
	type ReviewState,
	type RunRow,
	type RunState,
	type Thresholds,
} from "../contracts";

export { migrations } from "./migrations";

/** Larger model answers are not stored (the call row keeps `response_json` NULL). */
export const MAX_RESPONSE_BYTES = 64 * 1024;

// ---- assessments -----------------------------------------------------------------------

interface AssessmentDbRow {
	owner_kind: OwnerKind;
	owner_id: string;
	generality: Generality;
	signals_json: string;
	reason: string;
	origin: AssessmentRow["origin"];
	content_digest: string;
	prompt_version: string;
	call_id: string | null;
	created_at: string;
	updated_at: string;
}

const toAssessment = (r: AssessmentDbRow): AssessmentRow => ({
	ownerKind: r.owner_kind,
	ownerId: r.owner_id,
	generality: r.generality,
	signals: JSON.parse(r.signals_json) as Record<string, unknown>,
	reason: r.reason,
	origin: r.origin,
	contentDigest: r.content_digest,
	promptVersion: r.prompt_version,
	callId: r.call_id,
	createdAt: r.created_at,
	updatedAt: r.updated_at,
});

/** One assessment per (owner_kind, owner_id); an identical write changes nothing. */
export function upsertAssessment(
	db: Database,
	a: AssessmentInput,
): UpsertResult {
	return upsertRow(db, {
		table: "distill_assessments",
		key: { owner_kind: a.ownerKind, owner_id: a.ownerId },
		values: {
			generality: a.generality,
			signals_json: canonicalJson(a.signals),
			reason: a.reason,
			origin: a.origin,
			content_digest: a.contentDigest,
			prompt_version: a.promptVersion,
			call_id: a.callId,
		},
		insertOnly: { created_at: a.at },
		touch: { updated_at: a.at },
	});
}

export function getAssessment(
	db: Database,
	ownerKind: OwnerKind,
	ownerId: string,
): AssessmentRow | null {
	const row = db
		.query(
			"SELECT * FROM distill_assessments WHERE owner_kind = ? AND owner_id = ?",
		)
		.get(ownerKind, ownerId) as AssessmentDbRow | null;
	return row ? toAssessment(row) : null;
}

export function listAssessments(
	db: Database,
	filter: { ownerKind?: OwnerKind; generality?: Generality } = {},
): AssessmentRow[] {
	const where: string[] = [];
	const args: string[] = [];
	if (filter.ownerKind) {
		where.push("owner_kind = ?");
		args.push(filter.ownerKind);
	}
	if (filter.generality) {
		where.push("generality = ?");
		args.push(filter.generality);
	}
	return (
		db
			.query(
				`SELECT * FROM distill_assessments ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
				 ORDER BY owner_kind, owner_id`,
			)
			.all(...args) as AssessmentDbRow[]
	).map(toAssessment);
}

export function countAssessmentsByGenerality(
	db: Database,
	ownerKind?: OwnerKind,
): Record<Generality, number> {
	const out: Record<Generality, number> = {
		general: 0,
		generalizable: 0,
		repo_specific: 0,
		unusable: 0,
	};
	const rows = db
		.query(
			`SELECT generality, count(*) AS n FROM distill_assessments
			 ${ownerKind ? "WHERE owner_kind = ?" : ""} GROUP BY generality`,
		)
		.all(...(ownerKind ? [ownerKind] : [])) as {
		generality: Generality;
		n: number;
	}[];
	for (const r of rows) out[r.generality] = r.n;
	return out;
}

// ---- params ----------------------------------------------------------------------------

export function getParam<T = unknown>(db: Database, key: string): T | null {
	const row = db
		.query("SELECT value_json FROM distill_params WHERE key = ?")
		.get(key) as { value_json: string } | null;
	return row ? (JSON.parse(row.value_json) as T) : null;
}

export function setParam(
	db: Database,
	key: string,
	value: unknown,
	at: string,
): UpsertResult {
	return upsertRow(db, {
		table: "distill_params",
		key: { key },
		values: { value_json: canonicalJson(value) },
		touch: { updated_at: at },
	});
}

/** Deletes the params whose key starts with `prefix` (the work items of an ended run). */
export function deleteParamsWithPrefix(db: Database, prefix: string): number {
	return db
		.query("DELETE FROM distill_params WHERE substr(key, 1, ?) = ?")
		.run(prefix.length, prefix).changes;
}

/** Deletes one param. */
export function deleteParam(db: Database, key: string): boolean {
	return (
		db.query("DELETE FROM distill_params WHERE key = ?").run(key).changes > 0
	);
}

/** The stored thresholds, or the (uncalibrated) defaults. */
export function getThresholds(db: Database): Thresholds {
	const stored = getParam<Partial<Thresholds>>(db, "thresholds");
	return stored
		? { ...DEFAULT_THRESHOLDS, ...stored }
		: { ...DEFAULT_THRESHOLDS };
}

export function setThresholds(
	db: Database,
	thresholds: Thresholds,
	at: string,
): UpsertResult {
	return setParam(db, "thresholds", thresholds, at);
}

// ---- runs ------------------------------------------------------------------------------

interface RunDbRow {
	id: string;
	stage: DistillStage;
	params_json: string;
	state: RunState;
	counts_json: string;
	started_at: string;
	finished_at: string | null;
}

const toRun = (r: RunDbRow): RunRow => ({
	id: r.id,
	stage: r.stage,
	params: JSON.parse(r.params_json) as Record<string, unknown>,
	state: r.state,
	counts: JSON.parse(r.counts_json) as Record<string, number>,
	startedAt: r.started_at,
	finishedAt: r.finished_at,
});

export function createRun(
	db: Database,
	run: {
		id: string;
		stage: DistillStage;
		params: Record<string, unknown>;
		at: string;
	},
): void {
	db.query(
		`INSERT INTO distill_runs (id, stage, params_json, state, started_at)
		 VALUES (?, ?, ?, 'running', ?)`,
	).run(run.id, run.stage, canonicalJson(run.params), run.at);
}

export function getRun(db: Database, id: string): RunRow | null {
	const row = db
		.query("SELECT * FROM distill_runs WHERE id = ?")
		.get(id) as RunDbRow | null;
	return row ? toRun(row) : null;
}

/** The run of the stage that is still running, if any (newest first). */
export function findRunningRun(
	db: Database,
	stage: DistillStage,
): RunRow | null {
	const row = db
		.query(
			`SELECT * FROM distill_runs WHERE stage = ? AND state = 'running'
			 ORDER BY started_at DESC, id DESC LIMIT 1`,
		)
		.get(stage) as RunDbRow | null;
	return row ? toRun(row) : null;
}

export function listRuns(
	db: Database,
	filter: { stage?: DistillStage; limit?: number } = {},
): RunRow[] {
	return (
		db
			.query(
				`SELECT * FROM distill_runs ${filter.stage ? "WHERE stage = ?" : ""}
				 ORDER BY started_at DESC, id DESC LIMIT ?`,
			)
			.all(
				...(filter.stage ? [filter.stage] : []),
				filter.limit ?? 50,
			) as RunDbRow[]
	).map(toRun);
}

/** Adds `delta` to the named counters of the run (a missing counter starts at 0). */
export function addRunCounts(
	db: Database,
	id: string,
	delta: Record<string, number>,
): boolean {
	const run = getRun(db, id);
	if (!run) return false;
	const counts = { ...run.counts };
	for (const [k, v] of Object.entries(delta)) counts[k] = (counts[k] ?? 0) + v;
	db.query("UPDATE distill_runs SET counts_json = ? WHERE id = ?").run(
		canonicalJson(counts),
		id,
	);
	return true;
}

/** True when a running run was finished. */
export function finishRun(
	db: Database,
	id: string,
	state: Exclude<RunState, "running">,
	at: string,
): boolean {
	return (
		db
			.query(
				"UPDATE distill_runs SET state = ?, finished_at = ? WHERE id = ? AND state = 'running'",
			)
			.run(state, at, id).changes > 0
	);
}

/** Fails every running run (the caller has found that no distill job is left to finish them). */
export function failRunningRuns(db: Database, at: string): number {
	return db
		.query(
			"UPDATE distill_runs SET state = 'failed', finished_at = ? WHERE state = 'running'",
		)
		.run(at).changes;
}

// ---- llm calls -------------------------------------------------------------------------

interface LlmCallDbRow {
	id: string;
	run_id: string | null;
	stage: DistillStage;
	subject_ref: string;
	provider: string;
	model: string;
	prompt_version: string;
	input_digest: string;
	input_tokens: number | null;
	output_tokens: number | null;
	latency_ms: number;
	outcome: LlmCallRow["outcome"];
	response_json: string | null;
	created_at: string;
}

const toLlmCall = (r: LlmCallDbRow): LlmCallRow => ({
	id: r.id,
	runId: r.run_id,
	stage: r.stage,
	subjectRef: r.subject_ref,
	provider: r.provider,
	model: r.model,
	promptVersion: r.prompt_version,
	inputDigest: r.input_digest,
	inputTokens: r.input_tokens,
	outputTokens: r.output_tokens,
	latencyMs: r.latency_ms,
	outcome: r.outcome,
	response: r.response_json === null ? null : JSON.parse(r.response_json),
	createdAt: r.created_at,
});

export function insertLlmCall(db: Database, c: LlmCallInput): void {
	let response: string | null = null;
	if (c.response !== null && c.response !== undefined) {
		const json = JSON.stringify(c.response);
		if (
			json !== undefined &&
			new TextEncoder().encode(json).length <= MAX_RESPONSE_BYTES
		)
			response = json;
	}
	db.query(
		`INSERT INTO distill_llm_calls
		 (id, run_id, stage, subject_ref, provider, model, prompt_version, input_digest,
		  input_tokens, output_tokens, latency_ms, outcome, response_json, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		c.id,
		c.runId,
		c.stage,
		c.subjectRef,
		c.provider,
		c.model,
		c.promptVersion,
		c.inputDigest,
		c.inputTokens,
		c.outputTokens,
		c.latencyMs,
		c.outcome,
		response,
		c.at,
	);
}

export function getLlmCall(db: Database, id: string): LlmCallRow | null {
	const row = db
		.query("SELECT * FROM distill_llm_calls WHERE id = ?")
		.get(id) as LlmCallDbRow | null;
	return row ? toLlmCall(row) : null;
}

/**
 * The newest `ok` call with a stored answer for the digest (the key of a reusable answer),
 * answered by `model` when one is given.
 */
export function findOkCallByDigest(
	db: Database,
	inputDigest: string,
	model?: string,
): LlmCallRow | null {
	const row = db
		.query(
			`SELECT * FROM distill_llm_calls
			 WHERE input_digest = ? AND outcome = 'ok' AND response_json IS NOT NULL
			   AND (? IS NULL OR model = ?)
			 ORDER BY created_at DESC, rowid DESC LIMIT 1`,
		)
		.get(inputDigest, model ?? null, model ?? null) as LlmCallDbRow | null;
	return row ? toLlmCall(row) : null;
}

export function llmCallTotals(db: Database): {
	calls: number;
	inputTokens: number;
	outputTokens: number;
	invalidOutput: number;
} {
	const r = db
		.query(
			`SELECT count(*) AS calls, coalesce(sum(input_tokens), 0) AS i,
			        coalesce(sum(output_tokens), 0) AS o,
			        coalesce(sum(outcome = 'invalid_output'), 0) AS bad
			 FROM distill_llm_calls`,
		)
		.get() as { calls: number; i: number; o: number; bad: number };
	return {
		calls: r.calls,
		inputTokens: r.i,
		outputTokens: r.o,
		invalidOutput: r.bad,
	};
}

/**
 * Deletes failed calls (outcome other than 'ok') created before `before` (9.4: 30 days).
 * The 'ok' rows stay for audit and for reuse by digest. Returns the number deleted.
 */
export function pruneFailedLlmCalls(
	db: Database,
	before: string,
	limit = 500,
): number {
	return db
		.query(
			`DELETE FROM distill_llm_calls WHERE id IN (
			   SELECT id FROM distill_llm_calls
			   WHERE outcome != 'ok' AND created_at < ? ORDER BY created_at LIMIT ?)`,
		)
		.run(before, limit).changes;
}

// ---- pair judgments --------------------------------------------------------------------

interface PairDbRow {
	a_id: string;
	b_id: string;
	a_digest: string;
	b_digest: string;
	verdict: PairJudgmentRow["verdict"];
	resolution: PairJudgmentRow["resolution"];
	detail_json: string;
	call_id: string | null;
	created_at: string;
	updated_at: string;
}

const toPair = (r: PairDbRow): PairJudgmentRow => ({
	aId: r.a_id,
	bId: r.b_id,
	aDigest: r.a_digest,
	bDigest: r.b_digest,
	verdict: r.verdict,
	resolution: r.resolution,
	detail: JSON.parse(r.detail_json) as Record<string, unknown>,
	callId: r.call_id,
	createdAt: r.created_at,
	updatedAt: r.updated_at,
});

/** The pair in storage order (a_id < b_id): swaps the sides, and their digests, when needed. */
export function orderPair<
	T extends { aId: string; bId: string; aDigest: string; bDigest: string },
>(p: T): T {
	return p.aId <= p.bId
		? p
		: { ...p, aId: p.bId, bId: p.aId, aDigest: p.bDigest, bDigest: p.aDigest };
}

/** Stores the pair with a_id < b_id whatever the order given. */
export function upsertPairJudgment(
	db: Database,
	input: PairJudgmentInput,
): UpsertResult {
	const p = orderPair(input);
	if (p.aId === p.bId) throw new Error("invalid_pair");
	return upsertRow(db, {
		table: "distill_pair_judgments",
		key: { a_id: p.aId, b_id: p.bId },
		values: {
			a_digest: p.aDigest,
			b_digest: p.bDigest,
			verdict: p.verdict,
			resolution: p.resolution,
			detail_json: canonicalJson(p.detail),
			call_id: p.callId,
		},
		insertOnly: { created_at: input.at },
		touch: { updated_at: input.at },
	});
}

export function getPairJudgment(
	db: Database,
	x: string,
	y: string,
): PairJudgmentRow | null {
	const [a, b] = x <= y ? [x, y] : [y, x];
	const row = db
		.query("SELECT * FROM distill_pair_judgments WHERE a_id = ? AND b_id = ?")
		.get(a, b) as PairDbRow | null;
	return row ? toPair(row) : null;
}

export function listPairJudgments(
	db: Database,
	filter: {
		verdict?: PairJudgmentRow["verdict"];
		resolution?: PairJudgmentRow["resolution"];
	} = {},
): PairJudgmentRow[] {
	const where: string[] = [];
	const args: string[] = [];
	if (filter.verdict) {
		where.push("verdict = ?");
		args.push(filter.verdict);
	}
	if (filter.resolution) {
		where.push("resolution = ?");
		args.push(filter.resolution);
	}
	return (
		db
			.query(
				`SELECT * FROM distill_pair_judgments ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
				 ORDER BY a_id, b_id`,
			)
			.all(...args) as PairDbRow[]
	).map(toPair);
}

/**
 * Pairs judged `conflict` or `unknown` and not yet settled: the audit's `unresolved_conflict`
 * and the MCP `unresolved_conflict` warning share this one definition. With `ids`, only pairs
 * whose both sides are among them. Each pair is `[a, b]` with a < b.
 */
export function listUnresolvedConflictPairs(
	db: Database,
	ids?: readonly string[],
): [string, string][] {
	if (ids !== undefined && ids.length < 2) return [];
	const marks = ids?.map(() => "?").join(",");
	const rows = db
		.query(
			`SELECT a_id, b_id FROM distill_pair_judgments
			 WHERE verdict IN ('conflict', 'unknown')
			   AND resolution NOT IN ('a_wins', 'b_wins', 'owner_resolved')
			   ${ids ? `AND a_id IN (${marks}) AND b_id IN (${marks})` : ""}
			 ORDER BY a_id, b_id`,
		)
		.all(...(ids ? [...ids, ...ids] : [])) as { a_id: string; b_id: string }[];
	return rows.map((r) => [r.a_id, r.b_id]);
}

/** True when the resolution changed. */
export function setPairResolution(
	db: Database,
	x: string,
	y: string,
	resolution: PairJudgmentRow["resolution"],
	at: string,
): boolean {
	const [a, b] = x <= y ? [x, y] : [y, x];
	return (
		db
			.query(
				`UPDATE distill_pair_judgments SET resolution = ?, updated_at = ?
				 WHERE a_id = ? AND b_id = ? AND resolution != ?`,
			)
			.run(resolution, at, a, b, resolution).changes > 0
	);
}

// ---- reviews ---------------------------------------------------------------------------

interface ReviewDbRow {
	id: string;
	kind: ReviewKind;
	subject_json: string;
	proposal_json: string;
	state: ReviewState;
	resolution_json: string | null;
	created_at: string;
	resolved_at: string | null;
}

const toReview = (r: ReviewDbRow): ReviewRow => ({
	id: r.id,
	kind: r.kind,
	subject: JSON.parse(r.subject_json) as Record<string, unknown>,
	proposal: JSON.parse(r.proposal_json) as Record<string, unknown>,
	state: r.state,
	resolution:
		r.resolution_json === null
			? null
			: (JSON.parse(r.resolution_json) as Record<string, unknown>),
	createdAt: r.created_at,
	resolvedAt: r.resolved_at,
});

/**
 * Opens a review. The id is chosen by the caller from the subject, so a re-run opens the same
 * review once; an existing review (open or settled) is kept as it is. True when it was created.
 */
export function insertReview(db: Database, r: ReviewInput): boolean {
	return (
		db
			.query(
				`INSERT INTO distill_reviews (id, kind, subject_json, proposal_json, state, created_at)
				 VALUES (?, ?, ?, ?, 'open', ?)
				 ON CONFLICT(id) DO NOTHING`,
			)
			.run(
				r.id,
				r.kind,
				canonicalJson(r.subject),
				canonicalJson(r.proposal ?? {}),
				r.at,
			).changes > 0
	);
}

export function getReview(db: Database, id: string): ReviewRow | null {
	const row = db
		.query("SELECT * FROM distill_reviews WHERE id = ?")
		.get(id) as ReviewDbRow | null;
	return row ? toReview(row) : null;
}

export function listReviews(
	db: Database,
	state: ReviewState,
	kind?: ReviewKind,
): ReviewRow[] {
	return (
		db
			.query(
				`SELECT * FROM distill_reviews WHERE state = ? ${kind ? "AND kind = ?" : ""}
				 ORDER BY created_at, id`,
			)
			.all(...(kind ? [state, kind] : [state])) as ReviewDbRow[]
	).map(toReview);
}

/** Settles an open review. False when it does not exist or is already settled. */
export function settleReview(
	db: Database,
	id: string,
	state: Exclude<ReviewState, "open">,
	resolution: Record<string, unknown> | null,
	at: string,
): boolean {
	return (
		db
			.query(
				`UPDATE distill_reviews SET state = ?, resolution_json = ?, resolved_at = ?
				 WHERE id = ? AND state = 'open'`,
			)
			.run(
				state,
				resolution === null ? null : canonicalJson(resolution),
				at,
				id,
			).changes > 0
	);
}

export function countOpenReviewsByKind(
	db: Database,
): Record<ReviewKind, number> {
	const out: Record<ReviewKind, number> = {
		conflict: 0,
		low_confidence: 0,
		generality: 0,
		verifier_unknown: 0,
		host_rejected: 0,
	};
	const rows = db
		.query(
			"SELECT kind, count(*) AS n FROM distill_reviews WHERE state = 'open' GROUP BY kind",
		)
		.all() as { kind: ReviewKind; n: number }[];
	for (const r of rows) out[r.kind] = r.n;
	return out;
}
