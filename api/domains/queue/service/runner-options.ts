import type { QueueOptions } from "../types";

export interface Resolved {
	now: () => number;
	id: () => string;
	sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
	random: () => number;
	resources: Record<string, number>;
	resourceAliases: Record<string, string>;
	leaseMs: number;
	heartbeatMs: number;
	pollMs: number;
	backoff: { baseMs: number; maxMs: number };
	tickClaims: number;
	/** How long after the runner starts a job of an unregistered kind waits instead of failing. */
	handlerGraceMs: number;
	startedAtMs: number;
}

export type RunnerOptions = QueueOptions & { handlerGraceMs?: number };

/** A job of an unregistered kind waits (the feature may only be disabled for now) until the grace since start ends. */
export function handlerGraceReason(o: Resolved, now: number): string | null {
	return now - o.startedAtMs < o.handlerGraceMs ? "handler_unavailable" : null;
}

export function resolveOptions(o: RunnerOptions = {}): Resolved {
	return {
		now: o.now ?? Date.now,
		startedAtMs: (o.now ?? Date.now)(),
		id: o.id ?? (() => crypto.randomUUID()),
		sleep:
			o.sleep ??
			((ms, signal) =>
				new Promise((resolve) => {
					if (signal?.aborted) {
						resolve();
						return;
					}
					const finish = () => {
						clearTimeout(timer);
						signal?.removeEventListener("abort", finish);
						resolve();
					};
					const timer = setTimeout(finish, ms);
					signal?.addEventListener("abort", finish, { once: true });
				})),
		random: o.random ?? Math.random,
		resources: o.resources ?? { "inference.llm": 1 },
		resourceAliases: o.resourceAliases ?? {},
		leaseMs: o.leaseMs ?? 30_000,
		heartbeatMs: o.heartbeatMs ?? 10_000,
		pollMs: o.pollMs ?? 1_000,
		backoff: o.backoff ?? { baseMs: 1_000, maxMs: 30_000 },
		tickClaims: o.tickClaims ?? 16,
		handlerGraceMs: o.handlerGraceMs ?? 600_000,
	};
}
