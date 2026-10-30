import type { SqliteStore } from "../../../infrastructure/sqlite";
import { canonicalJson, sha256Hex } from "../../../infrastructure/digest";
import type { AttemptDto, JobDto, JobList, QueueStatus } from "../contracts";
import {
	findByDedupe,
	getJob,
	insertJob,
	listAttempts,
	listJobs,
	openCounts,
	openTotal,
	pruneTerminal,
	requestCancel,
	finishJob,
	endAttempt,
} from "../repository";
import type {
	AttemptRecord,
	EnqueueInput,
	HandlerDefinition,
	JobRecord,
	Tx,
} from "../types";
import { createRegistry } from "./registry";
import { createRunner } from "./runner";
import { resolveOptions, type RunnerOptions } from "./runner-options";

const QUEUE_RETENTION = {
	settledMs: 14 * 86_400_000,
	unknownMs: 90 * 86_400_000,
};
const MAX_PAYLOAD_BYTES = 16 * 1024;
const iso = (ms: number) => new Date(ms).toISOString();

export function toDto(job: JobRecord): JobDto {
	return {
		id: job.id,
		scope: job.scope,
		kind: job.kind,
		subjectRef: job.subjectRef,
		parentJobId: job.parentJobId,
		lane: job.lane,
		state: job.state,
		attempt: job.attempt,
		maxAttempts: job.maxAttempts,
		waitReason: job.waitReason,
		errorCode: job.errorCode,
		availableAt: iso(job.availableAtMs),
		deadlineAt: job.deadlineAtMs === null ? null : iso(job.deadlineAtMs),
		cancelRequestedAt:
			job.cancelRequestedAtMs === null ? null : iso(job.cancelRequestedAtMs),
		createdAt: iso(job.createdAtMs),
		updatedAt: iso(job.updatedAtMs),
		finishedAt: job.finishedAtMs === null ? null : iso(job.finishedAtMs),
		revision: job.revision,
	};
}
function attemptDto(a: AttemptRecord): AttemptDto {
	return {
		jobId: a.jobId,
		attempt: a.attempt,
		startedAt: iso(a.startedAtMs),
		endedAt: a.endedAtMs === null ? null : iso(a.endedAtMs),
		outcome: a.outcome,
		errorCode: a.errorCode,
	};
}
const canonical = (value: unknown) => canonicalJson(value);

export function createQueue(
	store: SqliteStore,
	options: RunnerOptions & {
		limits?: { total: number; background: number; scope: number };
	} = {},
) {
	const opts = resolveOptions(options);
	const limits = options.limits ?? { total: 1024, background: 768, scope: 128 };
	const registry = createRegistry();
	const runner = createRunner(store, registry, opts);

	function enqueueInTransaction(
		tx: Tx,
		input: EnqueueInput,
	): { job: JobRecord; fresh: boolean } {
		const handler = registry.get(input.kind);
		if (!handler) throw new Error("invalid_unknown_job_kind");
		const version = input.payloadVersion ?? handler.payloadVersions.at(-1) ?? 1;
		if (!handler.payloadVersions.includes(version))
			throw new Error("invalid_payload_version");
		const parsed = handler.schema.safeParse(input.payload);
		if (!parsed.success) throw new Error("invalid_job_payload");
		const payloadJson = canonical(parsed.data);
		if (new TextEncoder().encode(payloadJson).length > MAX_PAYLOAD_BYTES)
			throw new Error("invalid_job_payload_too_large");
		const resourceKey = input.resourceKey ?? handler.resourceKey ?? null;
		const maxAttempts = Math.min(3, Math.max(1, input.maxAttempts ?? 1));
		const digest = sha256Hex(
			canonical({
				version,
				payload: parsed.data,
				subjectRef: input.subjectRef ?? null,
				parent: input.parentJobId ?? null,
				lane: input.lane,
				resourceKey,
				concurrencyKey: input.concurrencyKey ?? null,
				maxAttempts,
			}),
		);
		const existing = findByDedupe(tx, input.scope, input.kind, input.dedupeKey);
		if (existing) {
			if (existing.inputDigest !== digest) throw new Error("request_conflict");
			return { job: existing, fresh: false };
		}
		const counts = openCounts(tx, input.scope);
		if (
			counts.total >= limits.total ||
			counts.scoped >= limits.scope ||
			(input.lane === "background" && counts.background >= limits.background)
		)
			throw new Error("queue_full");
		const now = opts.now();
		const job = insertJob(tx, {
			id: opts.id(),
			scope: input.scope,
			kind: input.kind,
			payloadVersion: version,
			dedupeKey: input.dedupeKey,
			payloadJson,
			inputDigest: digest,
			generation: 0,
			subjectRef: input.subjectRef ?? null,
			parentJobId: input.parentJobId ?? null,
			lane: input.lane,
			resourceKey,
			concurrencyKey: input.concurrencyKey ?? null,
			state: "queued",
			availableAtMs: input.availableAtMs ?? now,
			deadlineAtMs: input.deadlineAtMs ?? null,
			maxAttempts,
			owner: null,
			attempt: 0,
			leaseUntilMs: null,
			cancelRequestedAtMs: null,
			waitReason: null,
			errorCode: null,
			resultRef: null,
			recoveryPolicy: handler.recovery,
			createdAtMs: now,
			updatedAtMs: now,
		});
		return { job, fresh: true };
	}

	function cancelInTransaction(
		tx: Tx,
		jobId: string,
		reason: string,
	): { job: JobRecord; wasRunning: boolean } | null {
		const job = getJob(tx, jobId);
		if (!job) return null;
		if (!["queued", "running", "retry_wait"].includes(job.state))
			return { job, wasRunning: false };
		const handler = registry.get(job.kind);
		handler?.cancelInTransaction(
			tx,
			{
				jobId: job.id,
				subjectRef: job.subjectRef,
				payload: JSON.parse(job.payloadJson),
			},
			reason,
		);
		const now = opts.now();
		const running = job.state === "running";
		if (running) requestCancel(tx, job, now);
		else if (finishJob(tx, job, "cancelled", reason, now))
			endAttempt(tx, job.id, job.attempt, "cancelled", reason, now);
		return { job: getJob(tx, jobId) as JobRecord, wasRunning: running };
	}

	return {
		registerHandler<P, I, O>(definition: HandlerDefinition<P, I, O>) {
			registry.register(definition);
		},
		enqueueInTransaction,
		async enqueue(input: EnqueueInput) {
			const result = await store.write((tx) => enqueueInTransaction(tx, input));
			runner.wake();
			return result;
		},
		getInTransaction: (tx: Tx, id: string) => getJob(tx, id),
		findByDedupeInTransaction: findByDedupe,
		/** Deletes settled jobs older than 14 days and outcome_unknown ones older than 90; their dedupe keys become reusable. */
		pruneInTransaction: (tx: Tx, at: number, limit = 500) =>
			pruneTerminal(
				tx,
				at - QUEUE_RETENTION.settledMs,
				at - QUEUE_RETENTION.unknownMs,
				limit,
			),
		get: (id: string) => store.read((db) => getJob(db, id)),
		getDto(id: string): JobDto | null {
			const job = store.read((db) => getJob(db, id));
			return job ? toDto(job) : null;
		},
		list(
			filter: {
				scope?: string;
				state?: string;
				kind?: string;
				subjectRef?: string;
			} = {},
			cursor: string | null = null,
			limit = 50,
		): JobList {
			const size = Math.min(100, Math.max(1, limit));
			const from = cursor === null ? null : Number(cursor);
			if (from !== null && !Number.isInteger(from))
				throw new Error("invalid_cursor");
			const rows = store.read((db) => listJobs(db, filter, from, size + 1));
			const page = rows.slice(0, size);
			return {
				items: page.map(toDto),
				nextCursor:
					rows.length > size ? String(page.at(-1)?.createdSeq ?? "") : null,
			};
		},
		listAttempts(jobId: string): AttemptDto[] {
			return store.read((db) => listAttempts(db, jobId)).map(attemptDto);
		},
		cancelInTransaction,
		flushCancellations(jobIds: string[]) {
			for (const jobId of jobIds) {
				const job = store.read((db) => getJob(db, jobId));
				if (
					job &&
					(job.state === "cancelled" || job.cancelRequestedAtMs !== null)
				)
					runner.abort(jobId, "cancelled");
			}
			runner.wake();
		},
		async cancel(jobId: string, reason = "cancel_requested") {
			const result = await store.write((tx) =>
				cancelInTransaction(tx, jobId, reason),
			);
			if (result?.wasRunning) runner.abort(jobId, "cancelled");
			runner.wake();
			return result?.job ?? null;
		},
		stats(): QueueStatus {
			const now = opts.now();
			const lanes: QueueStatus["lanes"] = {
				interactive: { queued: 0, running: 0, failed: 0, oldestWaitMs: null },
				background: { queued: 0, running: 0, failed: 0, oldestWaitMs: null },
			};
			for (const row of runner.laneStats(now))
				lanes[row.lane] = {
					queued: row.queued,
					running: row.running,
					failed: row.failed,
					oldestWaitMs: row.oldest === null ? null : now - row.oldest,
				};
			const resources: QueueStatus["resources"] = {};
			for (const [key, capacity] of Object.entries(opts.resources))
				resources[key] = { inUse: runner.inUse(key), capacity };
			const last = runner.lastScanMs();
			return {
				lanes,
				resources,
				openJobs: store.read((db) => openTotal(db)),
				lastScanAt: last === null ? null : iso(last),
			};
		},
		wake: runner.wake,
		/** Run one scheduling pass. Used by tests and by the loop. */
		tick: runner.tick,
		recover: runner.recover,
		start: runner.start,
		close: runner.close,
	};
}
export type QueueService = ReturnType<typeof createQueue>;
