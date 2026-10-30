import type { Database } from "bun:sqlite";
import type { Migration } from "../../../infrastructure/sqlite";
import type { JobState } from "../contracts";
import type { AttemptRecord, JobRecord } from "../types";

export const migration = `
CREATE TABLE queue_jobs (
 id TEXT PRIMARY KEY,
 scope TEXT NOT NULL, kind TEXT NOT NULL, payload_version INTEGER NOT NULL, dedupe_key TEXT NOT NULL,
 payload_json TEXT NOT NULL, input_digest TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0,
 subject_ref TEXT, parent_job_id TEXT REFERENCES queue_jobs(id),
 lane TEXT NOT NULL CHECK(lane IN ('interactive','background')),
 resource_key TEXT, concurrency_key TEXT,
 state TEXT NOT NULL CHECK(state IN ('queued','running','retry_wait','cancel_requested','completed','failed','cancelled','expired','interrupted','outcome_unknown')),
 available_at_ms INTEGER NOT NULL, deadline_at_ms INTEGER, max_attempts INTEGER NOT NULL CHECK(max_attempts BETWEEN 1 AND 3),
 retry_policy_version INTEGER NOT NULL DEFAULT 1,
 owner TEXT, attempt INTEGER NOT NULL DEFAULT 0, lease_until_ms INTEGER, cancel_requested_at_ms INTEGER,
 wait_reason TEXT, error_code TEXT, result_ref TEXT,
 recovery_policy TEXT NOT NULL CHECK(recovery_policy IN ('replay_safe','interrupt')),
 created_seq INTEGER NOT NULL UNIQUE, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
 finished_at_ms INTEGER, revision INTEGER NOT NULL DEFAULT 0,
 UNIQUE(scope, kind, dedupe_key)
);
CREATE INDEX queue_jobs_ready ON queue_jobs(state, lane, available_at_ms, created_seq);
CREATE INDEX queue_jobs_scope ON queue_jobs(scope, state);
CREATE INDEX queue_jobs_concurrency ON queue_jobs(concurrency_key, state, created_seq);
CREATE INDEX queue_jobs_resource ON queue_jobs(resource_key, state);
CREATE INDEX queue_jobs_subject ON queue_jobs(subject_ref);
CREATE TABLE queue_attempts (
 job_id TEXT NOT NULL REFERENCES queue_jobs(id), attempt INTEGER NOT NULL, owner TEXT NOT NULL,
 started_at_ms INTEGER NOT NULL, ended_at_ms INTEGER, outcome TEXT, error_code TEXT,
 PRIMARY KEY (job_id, attempt)
);
`;

const OPEN = "('queued','running','retry_wait','cancel_requested')";
const columns = `id, scope, kind, payload_version, dedupe_key, payload_json, input_digest, generation, subject_ref, parent_job_id, lane, resource_key, concurrency_key, state, available_at_ms, deadline_at_ms, max_attempts, owner, attempt, lease_until_ms, cancel_requested_at_ms, wait_reason, error_code, result_ref, recovery_policy, created_seq, created_at_ms, updated_at_ms, finished_at_ms, revision`;

type Row = Record<string, unknown>;
function map(r: Row): JobRecord {
	return {
		id: r.id as string,
		scope: r.scope as string,
		kind: r.kind as string,
		payloadVersion: r.payload_version as number,
		dedupeKey: r.dedupe_key as string,
		payloadJson: r.payload_json as string,
		inputDigest: r.input_digest as string,
		generation: r.generation as number,
		subjectRef: r.subject_ref as string | null,
		parentJobId: r.parent_job_id as string | null,
		lane: r.lane as JobRecord["lane"],
		resourceKey: r.resource_key as string | null,
		concurrencyKey: r.concurrency_key as string | null,
		state: r.state as JobState,
		availableAtMs: r.available_at_ms as number,
		deadlineAtMs: r.deadline_at_ms as number | null,
		maxAttempts: r.max_attempts as number,
		owner: r.owner as string | null,
		attempt: r.attempt as number,
		leaseUntilMs: r.lease_until_ms as number | null,
		cancelRequestedAtMs: r.cancel_requested_at_ms as number | null,
		waitReason: r.wait_reason as string | null,
		errorCode: r.error_code as string | null,
		resultRef: r.result_ref as string | null,
		recoveryPolicy: r.recovery_policy as JobRecord["recoveryPolicy"],
		createdSeq: r.created_seq as number,
		createdAtMs: r.created_at_ms as number,
		updatedAtMs: r.updated_at_ms as number,
		finishedAtMs: r.finished_at_ms as number | null,
		revision: r.revision as number,
	};
}

export function getJob(db: Database, id: string): JobRecord | null {
	const row = db
		.query(`SELECT ${columns} FROM queue_jobs WHERE id = ?`)
		.get(id) as Row | null;
	return row ? map(row) : null;
}
export function findByDedupe(
	db: Database,
	scope: string,
	kind: string,
	key: string,
): JobRecord | null {
	const row = db
		.query(
			`SELECT ${columns} FROM queue_jobs WHERE scope=? AND kind=? AND dedupe_key=?`,
		)
		.get(scope, kind, key) as Row | null;
	return row ? map(row) : null;
}
export function openCounts(db: Database, scope: string) {
	const row = db
		.query(
			`SELECT COUNT(*) AS total, COALESCE(SUM(lane='background'),0) AS background, COALESCE(SUM(scope=?),0) AS scoped FROM queue_jobs WHERE state IN ${OPEN}`,
		)
		.get(scope) as { total: number; background: number; scoped: number };
	return row;
}
export function insertJob(
	db: Database,
	job: Omit<JobRecord, "createdSeq" | "revision" | "finishedAtMs">,
): JobRecord {
	const seq = (
		db
			.query("SELECT COALESCE(MAX(created_seq),0)+1 AS n FROM queue_jobs")
			.get() as { n: number }
	).n;
	db.query(
		`INSERT INTO queue_jobs (${columns}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
	).run(
		job.id,
		job.scope,
		job.kind,
		job.payloadVersion,
		job.dedupeKey,
		job.payloadJson,
		job.inputDigest,
		job.generation,
		job.subjectRef,
		job.parentJobId,
		job.lane,
		job.resourceKey,
		job.concurrencyKey,
		job.state,
		job.availableAtMs,
		job.deadlineAtMs,
		job.maxAttempts,
		job.owner,
		job.attempt,
		job.leaseUntilMs,
		job.cancelRequestedAtMs,
		job.waitReason,
		job.errorCode,
		job.resultRef,
		job.recoveryPolicy,
		seq,
		job.createdAtMs,
		job.updatedAtMs,
		null,
		0,
	);
	return getJob(db, job.id) as JobRecord;
}
export function candidates(
	db: Database,
	now: number,
	limit: number,
): JobRecord[] {
	return (
		db
			.query(
				`SELECT ${columns} FROM queue_jobs WHERE state IN ('queued','retry_wait') AND available_at_ms <= ? ORDER BY CASE lane WHEN 'interactive' THEN 0 ELSE 1 END, available_at_ms, created_seq LIMIT ?`,
			)
			.all(now, limit) as Row[]
	).map(map);
}
const LANE_RANK = "CASE lane WHEN 'interactive' THEN 0 ELSE 1 END";
export interface CandidateCursor {
	laneRank: number;
	availableAtMs: number;
	createdSeq: number;
}
export function cursorOf(job: JobRecord): CandidateCursor {
	return {
		laneRank: job.lane === "interactive" ? 0 : 1,
		availableAtMs: job.availableAtMs,
		createdSeq: job.createdSeq,
	};
}
/** Keyset page of `candidates`: same order, strictly after `after`. */
export function candidatesAfter(
	db: Database,
	now: number,
	limit: number,
	after: CandidateCursor | null,
): JobRecord[] {
	const cursor = after
		? ` AND (${LANE_RANK}, available_at_ms, created_seq) > (?, ?, ?)`
		: "";
	const params = after
		? [now, after.laneRank, after.availableAtMs, after.createdSeq, limit]
		: [now, limit];
	return (
		db
			.query(
				`SELECT ${columns} FROM queue_jobs WHERE state IN ('queued','retry_wait') AND available_at_ms <= ?${cursor} ORDER BY ${LANE_RANK}, available_at_ms, created_seq LIMIT ?`,
			)
			.all(...(params as never[])) as Row[]
	).map(map);
}
export function earlierOpenSameKey(db: Database, job: JobRecord): boolean {
	return (
		db
			.query(
				`SELECT 1 FROM queue_jobs WHERE concurrency_key=? AND created_seq<? AND state IN ${OPEN} LIMIT 1`,
			)
			.get(job.concurrencyKey, job.createdSeq) !== null
	);
}
export function setWaitReason(
	db: Database,
	id: string,
	reason: string | null,
	now: number,
) {
	db.query(
		"UPDATE queue_jobs SET wait_reason=?, updated_at_ms=? WHERE id=? AND state IN ('queued','retry_wait') AND wait_reason IS NOT ?",
	).run(reason, now, id, reason);
}
export function claimJob(
	db: Database,
	job: JobRecord,
	owner: string,
	leaseUntil: number,
	now: number,
): { attempt: number; generation: number } {
	const attempt = job.attempt + 1;
	const generation = job.generation + 1;
	const result = db
		.query(
			"UPDATE queue_jobs SET state='running', owner=?, attempt=?, generation=?, lease_until_ms=?, wait_reason=NULL, updated_at_ms=?, revision=revision+1 WHERE id=? AND state IN ('queued','retry_wait') AND revision=?",
		)
		.run(owner, attempt, generation, leaseUntil, now, job.id, job.revision);
	if (result.changes !== 1) throw new Error("queue_claim_race");
	db.query(
		"INSERT INTO queue_attempts (job_id, attempt, owner, started_at_ms) VALUES (?,?,?,?)",
	).run(job.id, attempt, owner, now);
	return { attempt, generation };
}
export function endAttempt(
	db: Database,
	jobId: string,
	attempt: number,
	outcome: string,
	errorCode: string | null,
	now: number,
) {
	db.query(
		"UPDATE queue_attempts SET ended_at_ms=?, outcome=?, error_code=? WHERE job_id=? AND attempt=? AND ended_at_ms IS NULL",
	).run(now, outcome, errorCode, jobId, attempt);
}
/** Move a job to a terminal state. `expected` guards owner/attempt/generation. */
export function finishJob(
	db: Database,
	job: JobRecord,
	state: JobState,
	errorCode: string | null,
	now: number,
	resultRef: string | null = null,
): boolean {
	const result = db
		.query(
			`UPDATE queue_jobs SET state=?, error_code=?, result_ref=COALESCE(?,result_ref), finished_at_ms=?, owner=NULL, lease_until_ms=NULL, wait_reason=NULL, updated_at_ms=?, revision=revision+1 WHERE id=? AND attempt=? AND generation=? AND state IN ${OPEN}`,
		)
		.run(
			state,
			errorCode,
			resultRef,
			now,
			now,
			job.id,
			job.attempt,
			job.generation,
		);
	return result.changes === 1;
}
export function requeueJob(
	db: Database,
	job: JobRecord,
	errorCode: string,
	availableAtMs: number,
	now: number,
): boolean {
	return (
		db
			.query(
				"UPDATE queue_jobs SET state='retry_wait', error_code=?, available_at_ms=?, owner=NULL, lease_until_ms=NULL, wait_reason='retry_backoff', generation=generation+1, updated_at_ms=?, revision=revision+1 WHERE id=? AND attempt=? AND generation=? AND state='running'",
			)
			.run(errorCode, availableAtMs, now, job.id, job.attempt, job.generation)
			.changes === 1
	);
}
export function requestCancel(db: Database, job: JobRecord, now: number) {
	db.query(
		"UPDATE queue_jobs SET state='cancel_requested', cancel_requested_at_ms=?, updated_at_ms=?, revision=revision+1 WHERE id=? AND state='running'",
	).run(now, now, job.id);
}
export function renewLease(
	db: Database,
	job: { jobId: string; owner: string; attempt: number; generation: number },
	leaseUntil: number,
	now: number,
): boolean {
	return (
		db
			.query(
				"UPDATE queue_jobs SET lease_until_ms=?, updated_at_ms=? WHERE id=? AND owner=? AND attempt=? AND generation=? AND state IN ('running','cancel_requested')",
			)
			.run(leaseUntil, now, job.jobId, job.owner, job.attempt, job.generation)
			.changes === 1
	);
}
export function expiredQueued(db: Database, now: number): JobRecord[] {
	return (
		db
			.query(
				`SELECT ${columns} FROM queue_jobs WHERE state IN ('queued','retry_wait') AND deadline_at_ms IS NOT NULL AND deadline_at_ms <= ? ORDER BY created_seq`,
			)
			.all(now) as Row[]
	).map(map);
}
export function runningJobs(db: Database): JobRecord[] {
	return (
		db
			.query(
				`SELECT ${columns} FROM queue_jobs WHERE state IN ('running','cancel_requested') ORDER BY created_seq`,
			)
			.all() as Row[]
	).map(map);
}
export function listJobs(
	db: Database,
	filter: {
		scope?: string;
		state?: string;
		kind?: string;
		subjectRef?: string;
	},
	cursor: number | null,
	limit: number,
): JobRecord[] {
	const where: string[] = [];
	const params: Array<string | number> = [];
	for (const [column, value] of [
		["scope", filter.scope],
		["state", filter.state],
		["kind", filter.kind],
		["subject_ref", filter.subjectRef],
	] as const)
		if (value !== undefined) {
			where.push(`${column}=?`);
			params.push(value);
		}
	if (cursor !== null) {
		where.push("created_seq<?");
		params.push(cursor);
	}
	return (
		db
			.query(
				`SELECT ${columns} FROM queue_jobs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_seq DESC LIMIT ?`,
			)
			.all(...params, limit) as Row[]
	).map(map);
}
export function listAttempts(db: Database, jobId: string): AttemptRecord[] {
	return (
		db
			.query(
				"SELECT job_id, attempt, owner, started_at_ms, ended_at_ms, outcome, error_code FROM queue_attempts WHERE job_id=? ORDER BY attempt",
			)
			.all(jobId) as Row[]
	).map((r) => ({
		jobId: r.job_id as string,
		attempt: r.attempt as number,
		owner: r.owner as string,
		startedAtMs: r.started_at_ms as number,
		endedAtMs: r.ended_at_ms as number | null,
		outcome: r.outcome as string | null,
		errorCode: r.error_code as string | null,
	}));
}
export function laneStats(db: Database, now: number) {
	return db
		.query(
			`SELECT lane,
 COALESCE(SUM(state IN ('queued','retry_wait')),0) AS queued,
 COALESCE(SUM(state IN ('running','cancel_requested')),0) AS running,
 COALESCE(SUM(state='failed'),0) AS failed,
 MIN(CASE WHEN state IN ('queued','retry_wait') AND available_at_ms <= ? THEN available_at_ms END) AS oldest
 FROM queue_jobs GROUP BY lane`,
		)
		.all(now) as Array<{
		lane: string;
		queued: number;
		running: number;
		failed: number;
		oldest: number | null;
	}>;
}
export function openTotal(db: Database): number {
	return (
		db
			.query(`SELECT COUNT(*) AS n FROM queue_jobs WHERE state IN ${OPEN}`)
			.get() as { n: number }
	).n;
}
/** Earliest future event (due time, deadline, lease expiry); past-due blocked work is re-judged by wake/poll. */
export function nextEventAt(db: Database, now: number): number | null {
	const row = db
		.query(
			`SELECT MIN(t) AS t FROM (
 SELECT MIN(available_at_ms) AS t FROM queue_jobs WHERE state IN ('queued','retry_wait') AND available_at_ms > ?1
 UNION ALL SELECT MIN(deadline_at_ms) FROM queue_jobs WHERE state IN ${OPEN} AND deadline_at_ms > ?1
 UNION ALL SELECT MIN(lease_until_ms) FROM queue_jobs WHERE state='running' AND lease_until_ms > ?1)`,
		)
		.get(now) as { t: number | null };
	return row.t;
}

const SETTLED = "('completed','failed','cancelled','expired','interrupted')";

/**
 * Deletes finished jobs (and their attempts) older than the cutoffs, oldest
 * first. `outcome_unknown` is kept longer (`unknownBefore`): operators inspect
 * it, and deleting it frees its dedupe key. A parent with surviving children and
 * the row with the highest `created_seq` (the next seq is MAX+1) are kept.
 */
export function pruneTerminal(
	db: Database,
	before: number,
	unknownBefore: number,
	limit: number,
): number {
	const ids = (
		db
			.query(
				`SELECT j.id FROM queue_jobs j
 WHERE j.finished_at_ms IS NOT NULL
   AND ((j.state IN ${SETTLED} AND j.finished_at_ms<=?) OR (j.state='outcome_unknown' AND j.finished_at_ms<=?))
   AND NOT EXISTS (SELECT 1 FROM queue_jobs c WHERE c.parent_job_id=j.id)
   AND j.created_seq < (SELECT MAX(created_seq) FROM queue_jobs)
 ORDER BY j.finished_at_ms LIMIT ?`,
			)
			.all(before, unknownBefore, limit) as { id: string }[]
	).map((r) => r.id);
	for (const id of ids) {
		db.query("DELETE FROM queue_attempts WHERE job_id=?").run(id);
		db.query("DELETE FROM queue_jobs WHERE id=?").run(id);
	}
	return ids.length;
}

/** Named migrations of this domain; the SQL above is frozen once deployed. */
export const migrations: readonly Migration[] = [
	{ id: "queue/0001-init", after: [], sql: migration },
];
