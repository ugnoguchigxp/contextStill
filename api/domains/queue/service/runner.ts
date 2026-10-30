import { getLogger, withLogContext } from "../../../infrastructure/logger";
const log = getLogger("queue");
import type { SqliteStore } from "../../../infrastructure/sqlite";
import {
	candidates,
	claimJob,
	endAttempt,
	expiredQueued,
	finishJob,
	getJob,
	laneStats,
	nextEventAt,
	renewLease,
	requeueJob,
	runningJobs,
	earlierOpenSameKey,
	setWaitReason,
} from "../repository";
import type {
	HandlerDefinition,
	JobRecord,
	SettleOutcome,
	SettleResult,
	Tx,
} from "../types";
import { type Registry, sync } from "./registry";
import { handlerGraceReason, type Resolved } from "./runner-options";
import {
	type Active,
	claimOf,
	scanCandidates,
	toErrorCode,
} from "./runner-shared";
import { createSettler } from "./settle";

export function createRunner(
	store: SqliteStore,
	registry: Registry,
	opts: Resolved,
) {
	const ownerId = `runner:${opts.id()}`;
	const active = new Map<string, Active>();
	let closing = false;
	let started: Promise<void> | null = null;
	let lastScanMs: number | null = null;
	let deferred = defer();
	let tickChain: Promise<unknown> = Promise.resolve();

	function defer() {
		let resolve: () => void = () => {};
		const promise = new Promise<void>((r) => {
			resolve = r;
		});
		return { promise, resolve };
	}
	function wake() {
		const current = deferred;
		deferred = defer();
		current.resolve();
	}
	const keyOf = (c: { jobId: string; attempt: number; generation: number }) =>
		`${c.jobId}:${c.attempt}:${c.generation}`;
	function findActive(jobId: string, generation?: number) {
		for (const a of active.values())
			if (
				a.claim.jobId === jobId &&
				(generation === undefined || a.claim.generation === generation)
			)
				return a;
		return undefined;
	}
	function usage(resource: string) {
		let n = 0;
		for (const a of active.values()) if (a.resourceKey === resource) n++;
		return n;
	}
	function backoffMs(attempt: number) {
		const base = Math.min(
			opts.backoff.maxMs,
			opts.backoff.baseMs * 2 ** (attempt - 1),
		);
		return Math.min(
			opts.backoff.maxMs,
			Math.round(base + base * 0.2 * opts.random()),
		);
	}
	/** Run a per-job step; a throwing business callback must not poison the whole sweep/recovery. */
	function isolated(db: Tx, step: () => void, onError: () => void) {
		db.exec("SAVEPOINT queue_isolated");
		try {
			step();
			db.exec("RELEASE queue_isolated");
		} catch {
			db.exec("ROLLBACK TO queue_isolated");
			db.exec("RELEASE queue_isolated");
			onError();
		}
	}
	/** Close the running attempt as non-adopted and finish the job. */
	function finishRunning(
		db: Tx,
		job: JobRecord,
		state:
			| "failed"
			| "expired"
			| "interrupted"
			| "outcome_unknown"
			| "cancelled",
		errorCode: string | null,
		now: number,
	) {
		if (finishJob(db, job, state, errorCode, now))
			endAttempt(db, job.id, job.attempt, state, errorCode, now);
	}
	function applyOutcome(
		db: Tx,
		job: JobRecord,
		handler: HandlerDefinition<unknown, unknown, unknown> | undefined,
		input: unknown,
		outcome: SettleOutcome<unknown>,
		now: number,
		hooks: Array<() => void>,
	): SettleResult {
		const claim = claimOf(job);
		if (handler) {
			const result = sync(
				handler.settleInTransaction(db, claim, input, outcome),
			);
			if (result === "stale") {
				finishRunning(db, job, "interrupted", "stale_result", now);
				return "stale";
			}
			if (typeof result === "object" && result.status === "failed") {
				finishRunning(db, job, "failed", result.errorCode, now);
				return result;
			}
		}
		switch (outcome.type) {
			case "success":
				if (finishJob(db, job, "completed", null, now, outcome.resultRef))
					endAttempt(db, job.id, job.attempt, "completed", null, now);
				break;
			case "retry":
				if (requeueJob(db, job, outcome.errorCode, outcome.availableAtMs, now))
					endAttempt(db, job.id, job.attempt, "retry", outcome.errorCode, now);
				break;
			case "failed":
				finishRunning(db, job, "failed", outcome.errorCode, now);
				break;
			case "expired":
				finishRunning(db, job, "expired", "deadline_exceeded", now);
				break;
			case "interrupted":
				finishRunning(db, job, "interrupted", outcome.errorCode, now);
				break;
		}
		if (handler?.afterCommit) hooks.push(() => handler.afterCommit?.());
		return "applied";
	}
	function runHooks(hooks: Array<() => void>) {
		for (const hook of hooks) {
			try {
				hook();
			} catch (error) {
				log.warn(
					"queue.after_commit_failed",
					{ reason: "after_commit_failed" },
					error,
				);
			}
		}
	}
	const pendingHooks: Array<() => void> = [];
	/**
	 * Writer transaction followed by the after-commit hooks it collected. Everything but claiming
	 * runs on the reserved lane: lease renewal, settlement, sweep and recovery must still go
	 * through when general writes have filled the writer queue.
	 */
	async function writeAndFlush<T>(
		fn: (db: Tx) => T,
		reserved = true,
	): Promise<T> {
		let hooks: Array<() => void> = [];
		const result = await store.write(
			(db) => {
				const start = pendingHooks.length;
				try {
					return fn(db);
				} finally {
					hooks = pendingHooks.splice(start);
				}
			},
			{ reserved },
		);
		runHooks(hooks);
		return result;
	}
	/** Resolve a running job whose execution cannot be trusted (lease lost, restart, forced shutdown). */
	function recoverRunning(
		db: Tx,
		job: JobRecord,
		code: string,
		now: number,
		allowReplay = true,
	) {
		if (job.state === "cancel_requested") {
			finishRunning(db, job, "outcome_unknown", code, now);
			return;
		}
		const handler = registry.get(job.kind);
		const replay =
			allowReplay &&
			handler?.recovery === "replay_safe" &&
			job.attempt < job.maxAttempts &&
			(job.deadlineAtMs === null || now < job.deadlineAtMs);
		isolated(
			db,
			() =>
				applyOutcome(
					db,
					job,
					handler,
					null,
					replay
						? {
								type: "retry",
								errorCode: code,
								availableAtMs: now + backoffMs(job.attempt),
							}
						: { type: "interrupted", errorCode: code },
					now,
					pendingHooks,
				),
			() => finishRunning(db, job, "interrupted", "settle_failed", now),
		);
	}

	/** A claim that cannot start still settles the owning domain so its state never hangs. */
	function failClaim(
		db: Tx,
		job: JobRecord,
		handler: HandlerDefinition<unknown, unknown, unknown> | undefined,
		code: string,
		now: number,
	) {
		isolated(
			db,
			() =>
				applyOutcome(
					db,
					job,
					handler,
					null,
					{ type: "failed", errorCode: code },
					now,
					pendingHooks,
				),
			() => finishRunning(db, job, "failed", code, now),
		);
	}

	type ClaimResult =
		| { type: "none" }
		| { type: "progress" }
		| { type: "claimed"; active: Omit<Active, "promise"> };

	function claimOne(db: Tx, now: number): ClaimResult {
		const reserved = new Set<string>();
		for (const a of active.values())
			if (a.concurrencyKey) reserved.add(a.concurrencyKey);
		for (const job of scanCandidates(db, now)) {
			const handler = registry.get(job.kind);
			const originalResource = job.resourceKey ?? handler?.resourceKey ?? null;
			const resource = originalResource
				? (opts.resourceAliases[originalResource] ?? originalResource)
				: null;
			let reason = handler ? null : handlerGraceReason(opts, now);
			if (handler && resource) {
				const cap = opts.resources[resource] ?? 1;
				if (usage(resource) >= cap) reason = "resource_busy";
			}
			if (
				!reason &&
				job.concurrencyKey &&
				(reserved.has(job.concurrencyKey) || earlierOpenSameKey(db, job))
			)
				reason = "conversation_order";
			if (reason) {
				if (job.waitReason !== reason) setWaitReason(db, job.id, reason, now);
				continue;
			}
			if (!handler || !handler.payloadVersions.includes(job.payloadVersion)) {
				const code = handler
					? "unsupported_payload_version"
					: "handler_not_registered";
				const current = claimJob(db, job, ownerId, now + opts.leaseMs, now);
				const claimed: JobRecord = {
					...job,
					...current,
					state: "running",
					owner: ownerId,
				};
				failClaim(db, claimed, handler, code, now);
				return { type: "progress" };
			}
			const claimed = claimJob(db, job, ownerId, now + opts.leaseMs, now);
			const running: JobRecord = {
				...job,
				...claimed,
				state: "running",
				owner: ownerId,
			};
			const claim = claimOf(running);
			db.exec("SAVEPOINT queue_prepare");
			try {
				const prepared = sync(handler.prepareInTransaction(db, claim));
				db.exec("RELEASE queue_prepare");
				if (prepared.status === "stale") {
					finishRunning(db, running, "cancelled", prepared.reason, now);
					return { type: "progress" };
				}
				return {
					type: "claimed",
					active: {
						claim,
						input: prepared.input,
						handler,
						controller: new AbortController(),
						heartbeat: new AbortController(),
						resourceKey: resource,
						concurrencyKey: job.concurrencyKey,
						lost: false,
						revoked: false,
						deadlineHit: false,
					},
				};
			} catch {
				db.exec("ROLLBACK TO queue_prepare");
				db.exec("RELEASE queue_prepare");
				failClaim(db, running, handler, "prepare_failed", now);
				return { type: "progress" };
			}
		}
		return { type: "none" };
	}

	const settle = createSettler({
		opts,
		writeCritical: writeAndFlush,
		finishRunning,
		applyOutcome,
		backoffMs,
		isClosing: () => closing,
		pendingHooks,
	});

	async function heartbeat(a: Active) {
		while (!a.heartbeat.signal.aborted) {
			await opts.sleep(opts.heartbeatMs, a.heartbeat.signal);
			if (a.heartbeat.signal.aborted) return;
			try {
				const now = opts.now();
				const ok = await store.write(
					(db) => renewLease(db, a.claim, now + opts.leaseMs, now),
					{ reserved: true },
				);
				if (!ok) {
					a.lost = true;
					a.controller.abort(new Error("lease_lost"));
					return;
				}
			} catch {
				log.warn("queue.heartbeat_failed", { jobId: a.claim.jobId });
				// Writer busy: retry next interval; the lease sweep decides if it expired.
			}
		}
	}

	async function execute(a: Active) {
		return withLogContext(
			{
				httpRequestId: undefined,
				requestId: undefined,
				jobId: a.claim.jobId,
				attempt: a.claim.attempt,
				generation: a.claim.generation,
			},
			() => executeLogged(a),
		);
	}
	async function executeLogged(a: Active) {
		const started = performance.now();
		log.info("queue.execution_started", { kind: a.handler.kind });
		void heartbeat(a);
		let result: { ok: true; value: unknown } | { ok: false; error: unknown };
		try {
			result = {
				ok: true,
				value: await a.handler.execute(a.input, {
					signal: a.controller.signal,
					jobId: a.claim.jobId,
					attempt: a.claim.attempt,
					generation: a.claim.generation,
				}),
			};
		} catch (error) {
			result = { ok: false, error };
			log.warn(
				"queue.execution_failed",
				{
					kind: a.handler.kind,
					durationMs: Math.round(performance.now() - started),
				},
				error,
			);
		}
		a.heartbeat.abort();
		try {
			if (a.revoked || a.lost) {
				log.warn("queue.result_discarded", {
					reason: a.lost ? "lease_lost" : "revoked",
				});
				return;
			}
			await settle(a, result);
			const current = store.read((db) => getJob(db, a.claim.jobId));
			log.info("queue.settled", {
				status: current?.state,
				reason:
					current?.errorCode && /^[a-z_]{1,80}$/.test(current.errorCode)
						? current.errorCode
						: undefined,
				durationMs: Math.round(performance.now() - started),
			});
		} catch (error) {
			log.error("queue.settlement_failed", { reason: "settle_failed" }, error);
			// Settlement transaction failed; the lease sweep resolves the job.
		} finally {
			active.delete(keyOf(a.claim));
			wake();
		}
	}

	async function sweep(now: number) {
		const needed = store.read(
			(db) =>
				expiredQueued(db, now).length > 0 ||
				runningJobs(db).some(
					(j) =>
						(j.deadlineAtMs !== null && j.deadlineAtMs <= now) ||
						(j.leaseUntilMs !== null && j.leaseUntilMs < now),
				),
		);
		if (!needed) return;
		await writeAndFlush((db) => {
			for (const job of expiredQueued(db, now)) {
				const handler = registry.get(job.kind);
				const claim = claimOf(job);
				isolated(
					db,
					() => {
						if (handler)
							sync(
								handler.settleInTransaction(db, claim, null, {
									type: "expired",
								}),
							);
					},
					() => {},
				);
				db.query(
					"UPDATE queue_jobs SET state='expired', error_code='deadline_exceeded', finished_at_ms=?, wait_reason=NULL, updated_at_ms=?, revision=revision+1 WHERE id=? AND state IN ('queued','retry_wait')",
				).run(now, now, job.id);
			}
			for (const job of runningJobs(db)) {
				const a = findActive(job.id, job.generation);
				if (
					a &&
					job.deadlineAtMs !== null &&
					job.deadlineAtMs <= now &&
					!a.deadlineHit
				) {
					a.deadlineHit = true;
					a.controller.abort(new Error("deadline_exceeded"));
				}
				if (job.leaseUntilMs !== null && job.leaseUntilMs < now) {
					if (a) {
						a.lost = true;
						a.controller.abort(new Error("lease_expired"));
						a.heartbeat.abort();
					}
					recoverRunning(db, job, "lease_expired", now);
				}
			}
		});
	}

	async function tickInner() {
		const now = opts.now();
		await sweep(now);
		for (let i = 0; i < opts.tickClaims && !closing; i++) {
			if (!store.read((db) => candidates(db, opts.now(), 1).length > 0)) break;
			const result = await writeAndFlush(
				(db) => claimOne(db, opts.now()),
				false,
			);
			if (result.type === "none") break;
			if (result.type === "claimed") {
				const a = result.active as Active;
				active.set(keyOf(a.claim), a);
				if (closing) a.controller.abort(new Error("shutdown"));
				a.promise = execute(a);
			}
		}
		lastScanMs = opts.now();
	}
	function tick() {
		const run = tickChain.then(tickInner, tickInner);
		tickChain = run.catch(() => {});
		return run;
	}

	async function loop() {
		let tickFailures = 0;
		while (!closing) {
			const mine = deferred;
			let delay = opts.pollMs;
			try {
				await tick();
				const next = store.read((db) => nextEventAt(db, opts.now()));
				if (next !== null)
					delay = Math.max(10, Math.min(opts.pollMs, next - opts.now()));
				tickFailures = 0;
			} catch (error) {
				log.warn("queue.tick_failed", { reason: toErrorCode(error) }, error);
				// Writer full or closing: back off and re-check; do not fake progress.
				delay =
					Math.min(
						opts.pollMs * 8,
						opts.backoff.baseMs * 2 ** Math.min(tickFailures, 16),
					) + Math.floor(Math.random() * opts.backoff.baseMs);
				tickFailures++;
			}
			if (closing) break;
			const timer = new AbortController();
			await Promise.race([mine.promise, opts.sleep(delay, timer.signal)]);
			timer.abort();
		}
	}

	return {
		wake,
		tick,
		start() {
			if (!started && !closing) started = loop();
		},
		async recover() {
			const now = opts.now();
			return writeAndFlush((db) => {
				let n = 0;
				for (const job of runningJobs(db)) {
					recoverRunning(db, job, "backend_restarted", now);
					n++;
				}
				return n;
			});
		},
		abort(jobId: string, reason: string) {
			for (const a of active.values())
				if (a.claim.jobId === jobId) a.controller.abort(new Error(reason));
		},
		async close(drainMs = 10_000) {
			if (closing) return;
			closing = true;
			wake();
			for (const a of active.values())
				a.controller.abort(new Error("shutdown"));
			await started?.catch(() => {});
			const pending = [...active.values()].map((a) => a.promise);
			const drain = new AbortController();
			await Promise.race([
				Promise.allSettled(pending),
				opts.sleep(drainMs, drain.signal),
			]);
			drain.abort();
			const leftover = [...active.values()];
			if (leftover.length === 0) return;
			for (const a of leftover) {
				a.revoked = true;
				a.heartbeat.abort();
			}
			const now = opts.now();
			await writeAndFlush((db) => {
				for (const a of leftover) {
					const job = getJob(db, a.claim.jobId);
					if (
						job &&
						(job.state === "running" || job.state === "cancel_requested")
					)
						recoverRunning(db, job, "shutdown_timeout", now, false);
				}
			}).catch(() => {});
		},
		inUse(resource: string) {
			return usage(resource);
		},
		activeIds: () => [...active.values()].map((a) => a.claim.jobId),
		laneStats(now: number) {
			return store.read((db) => laneStats(db, now));
		},
		lastScanMs: () => lastScanMs,
	};
}
