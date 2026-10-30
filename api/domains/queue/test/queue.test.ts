import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import { createQueue, migration, type HandlerDefinition } from "..";
import { waitFor as until } from "../../../infrastructure/wait-for";

const dirs: string[] = [];
const stores: SqliteStore[] = [];
afterEach(async () => {
	for (const s of stores.splice(0)) await s.close().catch(() => {});
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const businessMigration = `CREATE TABLE fake_items (id TEXT PRIMARY KEY, state TEXT NOT NULL, result TEXT);`;
function setup(options: Parameters<typeof createQueue>[1] = {}) {
	const dir = mkdtempSync(join(tmpdir(), "context-still-queue-"));
	dirs.push(dir);
	const file = join(dir, "db.sqlite3");
	const store = openStore(file, [businessMigration, migration]);
	stores.push(store);
	const clock = { t: 1_000_000 };
	const queue = createQueue(store, {
		now: () => clock.t,
		id: () => crypto.randomUUID(),
		sleep: () => new Promise(() => {}),
		random: () => 0,
		...options,
	});
	return { dir, file, store, queue, clock };
}
// Macrotask yields (no wall-clock wait) let queued microtasks and writer flushes settle.
const yieldTurn = () => new Promise((r) => setImmediate(r));
const flush = async () => {
	for (let i = 0; i < 20; i++) await yieldTurn();
};
/** Injected `sleep`: waits until the test fires it (by duration), or the signal aborts. */
function manualSleep() {
	const waiters = new Set<{ ms: number; done: () => void }>();
	return {
		sleep: (ms: number, signal?: AbortSignal) =>
			new Promise<void>((resolve) => {
				const waiter = {
					ms,
					done: () => {
						waiters.delete(waiter);
						resolve();
					},
				};
				waiters.add(waiter);
				signal?.addEventListener("abort", waiter.done, { once: true });
			}),
		waiting: (ms: number) => [...waiters].some((w) => w.ms === ms),
		fire(ms: number) {
			for (const w of waiters) if (w.ms === ms) w.done();
		},
	};
}

interface Control {
	calls: string[];
	gates: Map<
		string,
		{ resolve: (v: string) => void; reject: (e: Error) => void }
	>;
	executed: number;
	failSettle: boolean;
	ignoreSignal: boolean;
}
function fakeHandler(
	store: SqliteStore,
	control: Control,
	extra: Partial<
		HandlerDefinition<{ id: string }, { id: string }, string>
	> = {},
): HandlerDefinition<{ id: string }, { id: string }, string> {
	return {
		kind: "fake.work",
		payloadVersions: [1],
		schema: z.object({ id: z.string() }),
		recovery: "interrupt",
		resourceKey: "fake.res",
		prepareInTransaction(tx, claim) {
			tx.query("UPDATE fake_items SET state='running' WHERE id=?").run(
				claim.payload.id,
			);
			control.calls.push(`prepare:${claim.payload.id}`);
			return { status: "ready", input: { id: claim.payload.id } };
		},
		execute(input, { signal }) {
			control.executed++;
			return new Promise<string>((resolve, reject) => {
				control.gates.set(input.id, { resolve, reject });
				if (!control.ignoreSignal)
					signal.addEventListener("abort", () => reject(new Error("aborted")));
			});
		},
		classify: (e) => (String(e).includes("transient") ? "retry" : "fail"),
		settleInTransaction(tx, claim, _input, outcome) {
			if (control.failSettle && outcome.type === "success")
				throw new Error("business_failed");
			const state =
				outcome.type === "success"
					? "done"
					: outcome.type === "retry"
						? "queued"
						: outcome.type;
			tx.query("UPDATE fake_items SET state=?, result=? WHERE id=?").run(
				state,
				outcome.type === "success" ? outcome.result : null,
				claim.payload.id,
			);
			return "applied";
		},
		cancelInTransaction(tx, job) {
			tx.query("UPDATE fake_items SET state='cancelled' WHERE id=?").run(
				job.payload.id,
			);
		},
		...extra,
	};
}
const control = (): Control => ({
	calls: [],
	gates: new Map(),
	executed: 0,
	failSettle: false,
	ignoreSignal: false,
});
function item(store: SqliteStore, id: string) {
	return store.read(
		(db) =>
			db.query("SELECT state, result FROM fake_items WHERE id=?").get(id) as {
				state: string;
				result: string | null;
			},
	);
}
function enqueue(
	h: ReturnType<typeof setup>,
	id: string,
	extra: Record<string, unknown> = {},
) {
	return h.store.write((db) => {
		db.query("INSERT INTO fake_items (id,state) VALUES (?, 'queued')").run(id);
		return h.queue.enqueueInTransaction(db, {
			scope: "test",
			kind: "fake.work",
			dedupeKey: id,
			payload: { id },
			lane: "interactive",
			...extra,
		});
	});
}

test("same dedupe key converges; different content conflicts; capacity rejects atomically", async () => {
	const h = setup({ limits: { total: 2, background: 2, scope: 2 } });
	h.queue.registerHandler(fakeHandler(h.store, control()));
	const a = await enqueue(h, "a");
	const again = await h.queue.enqueue({
		scope: "test",
		kind: "fake.work",
		dedupeKey: "a",
		payload: { id: "a" },
		lane: "interactive",
	});
	expect(again.fresh).toBe(false);
	expect(again.job.id).toBe(a.job.id);
	await expect(
		h.queue.enqueue({
			scope: "test",
			kind: "fake.work",
			dedupeKey: "a",
			payload: { id: "a" },
			lane: "background",
		}),
	).rejects.toThrow("request_conflict");
	await enqueue(h, "b");
	await expect(enqueue(h, "c")).rejects.toThrow("queue_full");
	// the business row was rolled back with the rejected job
	expect(
		h.store.read((db) => db.query("SELECT id FROM fake_items").all()),
	).toHaveLength(2);
});

test("success settles business and job together; failure of business rolls both back", async () => {
	const h = setup();
	const c = control();
	h.queue.registerHandler(fakeHandler(h.store, c));
	const a = await enqueue(h, "a");
	await h.queue.tick();
	await until(() => c.gates.has("a"));
	c.failSettle = true;
	c.gates.get("a")?.resolve("ok");
	await until(() => h.queue.get(a.job.id)?.state === "failed");
	expect(h.queue.get(a.job.id)?.errorCode).toBe("settle_failed");
	expect(item(h.store, "a").state).toBe("failed");
	const b = await enqueue(h, "b");
	c.failSettle = false;
	await h.queue.tick();
	await until(() => c.gates.has("b"));
	c.gates.get("b")?.resolve("answer");
	await until(() => h.queue.get(b.job.id)?.state === "completed");
	expect(item(h.store, "b")).toEqual({ state: "done", result: "answer" });
	expect(h.queue.listAttempts(b.job.id)[0]?.outcome).toBe("completed");
});

test("resource slot and concurrency key serialize claims; interactive goes first", async () => {
	const h = setup();
	const c = control();
	h.queue.registerHandler(fakeHandler(h.store, c));
	await enqueue(h, "bg", { lane: "background" });
	await enqueue(h, "k1", { concurrencyKey: "conversation:x" });
	await enqueue(h, "k2", { concurrencyKey: "conversation:x" });
	await Promise.all([h.queue.tick(), h.queue.tick()]);
	await flush();
	expect(c.executed).toBe(1);
	expect([...c.gates.keys()]).toEqual(["k1"]);
	const waiting = h.queue.list({ state: "queued" }).items;
	expect(waiting.map((j) => j.waitReason).sort()).toEqual([
		"resource_busy",
		"resource_busy",
	]);
	c.gates.get("k1")?.resolve("1");
	await until(() => item(h.store, "k1").state === "done");
	await h.queue.tick();
	await until(() => c.gates.has("k2"));
	// k2 (same conversation, earlier) is claimed before bg only because it is interactive
	expect(c.gates.has("bg")).toBe(false);
});

test("order within a conversation is kept even when a later job is interactive and earlier is background", async () => {
	const h = setup({ resources: { "fake.res": 2 } });
	const c = control();
	h.queue.registerHandler(fakeHandler(h.store, c));
	await enqueue(h, "first", {
		lane: "background",
		concurrencyKey: "conversation:y",
	});
	await enqueue(h, "second", {
		lane: "interactive",
		concurrencyKey: "conversation:y",
	});
	await h.queue.tick();
	await flush();
	expect([...c.gates.keys()]).toEqual(["first"]);
});

test("retry only for allowed transient failures, with finite attempts and backoff", async () => {
	const h = setup({ backoff: { baseMs: 1000, maxMs: 30000 } });
	const c = control();
	h.queue.registerHandler(fakeHandler(h.store, c));
	const a = await enqueue(h, "a", { maxAttempts: 2 });
	await h.queue.tick();
	await until(() => c.gates.has("a"));
	c.gates.get("a")?.reject(new Error("transient"));
	await until(() => h.queue.get(a.job.id)?.state === "retry_wait");
	expect(h.queue.get(a.job.id)?.availableAtMs).toBe(h.clock.t + 1000);
	await h.queue.tick();
	await flush();
	expect(c.executed).toBe(1); // not yet available
	h.clock.t += 1000;
	c.gates.clear();
	await h.queue.tick();
	await until(() => c.gates.has("a"));
	c.gates.get("a")?.reject(new Error("transient"));
	await until(() => h.queue.get(a.job.id)?.state === "failed");
	expect(h.queue.listAttempts(a.job.id).map((x) => x.outcome)).toEqual([
		"retry",
		"failed",
	]);
	const b = await enqueue(h, "b");
	await h.queue.tick();
	await until(() => c.gates.has("b"));
	c.gates.get("b")?.reject(new Error("permanent"));
	await until(() => h.queue.get(b.job.id)?.state === "failed");
	expect(h.queue.get(b.job.id)?.attempt).toBe(1);
});

test("unregistered kind and unsupported version fail explicitly", async () => {
	const h = setup({ handlerGraceMs: 0 });
	const c = control();
	h.queue.registerHandler(fakeHandler(h.store, c));
	const a = await enqueue(h, "a");
	// simulate a job from a newer build
	await h.store.write((db) =>
		db
			.query("UPDATE queue_jobs SET payload_version=9 WHERE id=?")
			.run(a.job.id),
	);
	const b = await enqueue(h, "b");
	await h.store.write((db) =>
		db.query("UPDATE queue_jobs SET kind='gone.kind' WHERE id=?").run(b.job.id),
	);
	await h.queue.tick();
	expect(h.queue.get(a.job.id)?.errorCode).toBe("unsupported_payload_version");
	expect(h.queue.get(b.job.id)?.errorCode).toBe("handler_not_registered");
	expect(c.executed).toBe(0);
});

test("a job of an unregistered kind waits through the handler grace, then fails", async () => {
	const h = setup();
	const c = control();
	h.queue.registerHandler(fakeHandler(h.store, c));
	const a = await enqueue(h, "a");
	await h.store.write((db) =>
		db.query("UPDATE queue_jobs SET kind='gone.kind' WHERE id=?").run(a.job.id),
	);
	await h.queue.tick();
	h.clock.t += 599_999;
	await h.queue.tick();
	expect(h.queue.get(a.job.id)?.state).toBe("queued");
	expect(h.queue.get(a.job.id)?.waitReason).toBe("handler_unavailable");
	h.clock.t += 1;
	await h.queue.tick();
	expect(h.queue.get(a.job.id)?.state).toBe("failed");
	expect(h.queue.get(a.job.id)?.errorCode).toBe("handler_not_registered");
});

test("a runner recreated with the handler runs a job that waited through the grace", async () => {
	const h = setup();
	const c = control();
	h.queue.registerHandler(fakeHandler(h.store, c));
	const a = await enqueue(h, "a");
	await h.store.write((db) =>
		db.query("UPDATE queue_jobs SET kind='late.kind' WHERE id=?").run(a.job.id),
	);
	await h.queue.tick();
	expect(h.queue.get(a.job.id)?.waitReason).toBe("handler_unavailable");
	const second = createQueue(h.store, {
		now: () => h.clock.t,
		id: () => crypto.randomUUID(),
		sleep: () => new Promise(() => {}),
		random: () => 0,
	});
	second.registerHandler({ ...fakeHandler(h.store, c), kind: "late.kind" });
	await second.tick();
	await until(() => c.gates.has("a"));
	expect(second.get(a.job.id)?.state).toBe("running");
	expect(second.get(a.job.id)?.waitReason).toBeNull();
	c.gates.get("a")?.resolve("ok");
	await until(() => second.get(a.job.id)?.state === "completed");
	await second.close(1000);
});

test("jobs waiting for a missing handler do not starve other kinds", async () => {
	const h = setup({
		limits: { total: 5000, background: 5000, scope: 5000 },
	});
	const c = control();
	h.queue.registerHandler(fakeHandler(h.store, c));
	const ids: string[] = [];
	for (let i = 0; i < 1000; i++) ids.push((await enqueue(h, `w${i}`)).job.id);
	await h.store.write((db) =>
		db.query("UPDATE queue_jobs SET kind='gone.kind'").run(),
	);
	const live = await enqueue(h, "live");
	await h.queue.tick();
	await until(() => c.gates.has("live"));
	expect(h.queue.get(live.job.id)?.state).toBe("running");
	expect(h.queue.get(ids[999]!)?.waitReason).toBe("handler_unavailable");
});

test("cancel of running job rejects late result and keeps the slot until the handler stops", async () => {
	const h = setup();
	const c = control();
	c.ignoreSignal = true;
	h.queue.registerHandler(fakeHandler(h.store, c));
	const a = await enqueue(h, "a");
	const b = await enqueue(h, "b");
	await h.queue.tick();
	await until(() => c.gates.has("a"));
	const cancelled = await h.queue.cancel(a.job.id);
	expect(cancelled?.state).toBe("cancel_requested");
	expect(item(h.store, "a").state).toBe("cancelled");
	await h.queue.tick();
	await flush();
	expect(c.gates.has("b")).toBe(false); // slot not reused
	expect(h.queue.get(b.job.id)?.waitReason).toBe("resource_busy");
	c.gates.get("a")?.resolve("late answer");
	await until(() => h.queue.get(a.job.id)?.state === "cancelled");
	expect(item(h.store, "a")).toEqual({ state: "cancelled", result: null });
	await h.queue.tick();
	await until(() => c.gates.has("b"));
});

test("cancel of queued job is immediate and routed through the handler", async () => {
	const h = setup();
	h.queue.registerHandler(fakeHandler(h.store, control()));
	const a = await enqueue(h, "a");
	expect((await h.queue.cancel(a.job.id))?.state).toBe("cancelled");
	expect(item(h.store, "a").state).toBe("cancelled");
	expect((await h.queue.cancel(a.job.id))?.state).toBe("cancelled");
});

test("lost lease: old result is rejected and the resource is not reused while the old handler lives", async () => {
	const h = setup({ leaseMs: 30_000 });
	const c = control();
	c.ignoreSignal = true;
	h.queue.registerHandler(fakeHandler(h.store, c));
	const a = await enqueue(h, "a");
	const b = await enqueue(h, "b");
	await h.queue.tick();
	await until(() => c.gates.has("a"));
	h.clock.t += 31_000;
	await h.queue.tick();
	expect(h.queue.get(a.job.id)?.state).toBe("interrupted");
	expect(h.queue.get(a.job.id)?.errorCode).toBe("lease_expired");
	expect(c.gates.has("b")).toBe(false);
	expect(h.queue.get(b.job.id)?.waitReason).toBe("resource_busy");
	c.gates.get("a")?.resolve("stale answer");
	await flush();
	expect(item(h.store, "a").state).toBe("interrupted");
	await h.queue.tick();
	await until(() => c.gates.has("b"));
});

test("deadline aborts the running handler and expires the job without adopting a late result", async () => {
	const h = setup();
	const c = control();
	h.queue.registerHandler(fakeHandler(h.store, c));
	const a = await enqueue(h, "a", { deadlineAtMs: h.clock.t + 5000 });
	await h.queue.tick();
	await until(() => c.gates.has("a"));
	h.clock.t += 6000;
	await h.queue.tick();
	await until(() => h.queue.get(a.job.id)?.state === "expired");
	expect(item(h.store, "a").state).toBe("expired");
	const q = await enqueue(h, "q", { deadlineAtMs: h.clock.t + 10 });
	h.clock.t += 20;
	await h.queue.tick();
	expect(h.queue.get(q.job.id)?.state).toBe("expired");
});

test("recover: queued continue, running follows policy, cancel_requested becomes outcome_unknown", async () => {
	const h = setup();
	const c = control();
	c.ignoreSignal = true;
	h.queue.registerHandler(fakeHandler(h.store, c));
	const safe = fakeHandler(h.store, c, {
		kind: "fake.safe",
		recovery: "replay_safe",
		resourceKey: "safe.res",
	});
	h.queue.registerHandler(safe);
	const a = await enqueue(h, "a");
	const k = await enqueue(h, "k", { resourceKey: "other.res" });
	await h.store.write((db) => {
		db.query("INSERT INTO fake_items (id,state) VALUES ('s','queued')").run();
		return h.queue.enqueueInTransaction(db, {
			scope: "test",
			kind: "fake.safe",
			dedupeKey: "s",
			payload: { id: "s" },
			lane: "interactive",
			maxAttempts: 2,
		});
	});
	const q = await enqueue(h, "q", { concurrencyKey: "conv" });
	await h.queue.tick();
	await until(() => c.gates.has("a") && c.gates.has("s") && c.gates.has("k"));
	await h.queue.cancel(k.job.id);
	// simulate restart: a fresh queue instance over the same DB
	const queue2 = createQueue(h.store, {
		now: () => h.clock.t,
		sleep: () => new Promise(() => {}),
		random: () => 0,
	});
	queue2.registerHandler(fakeHandler(h.store, control()));
	queue2.registerHandler(
		fakeHandler(h.store, control(), {
			kind: "fake.safe",
			recovery: "replay_safe",
		}),
	);
	expect(await queue2.recover()).toBe(3);
	expect(queue2.get(a.job.id)?.state).toBe("interrupted");
	expect(queue2.get(k.job.id)?.state).toBe("outcome_unknown");
	const s = queue2.list({ kind: "fake.safe" }).items[0];
	expect(s?.state).toBe("retry_wait");
	expect(queue2.get(q.job.id)?.state).toBe("queued");
	expect(item(h.store, "a").state).toBe("interrupted");
});

test("lost wake-up: the loop still finds committed work within the poll interval; idle never calls handlers", async () => {
	const poll = manualSleep();
	const h = setup({
		pollMs: 20,
		sleep: poll.sleep,
	});
	const c = control();
	h.queue.registerHandler(fakeHandler(h.store, c));
	h.queue.start();
	h.queue.start();
	for (let i = 0; i < 3; i++) {
		await until(() => poll.waiting(20));
		poll.fire(20); // three idle poll intervals elapse
	}
	await until(() => poll.waiting(20));
	expect(c.calls).toEqual([]);
	// commit without wake(); the next poll interval finds it
	await enqueue(h, "a");
	poll.fire(20);
	await until(() => c.gates.has("a"));
	c.gates.get("a")?.resolve("x");
	await until(() => item(h.store, "a").state === "done");
	await h.queue.close(500);
});

test("close aborts running handlers, settles them interrupted, and blocks late writes", async () => {
	const poll = manualSleep();
	const h = setup({
		pollMs: 20,
		sleep: poll.sleep,
	});
	const c = control();
	c.ignoreSignal = true;
	h.queue.registerHandler(fakeHandler(h.store, c));
	h.queue.start();
	const a = await enqueue(h, "a");
	await until(() => c.gates.has("a"));
	const closing = h.queue.close(30);
	await until(() => poll.waiting(30));
	poll.fire(30); // the 30 ms drain deadline elapses with the handler still running
	await closing;
	expect(h.queue.get(a.job.id)?.state).toBe("interrupted");
	expect(h.queue.get(a.job.id)?.errorCode).toBe("shutdown_timeout");
	c.gates.get("a")?.resolve("late");
	await flush();
	expect(item(h.store, "a").state).toBe("interrupted");
});

test("async transaction callbacks are rejected", async () => {
	const h = setup();
	const c = control();
	h.queue.registerHandler(
		fakeHandler(h.store, c, {
			prepareInTransaction: (async () => ({
				status: "ready",
				input: { id: "a" },
			})) as never,
		}),
	);
	const a = await enqueue(h, "a");
	await h.queue.tick();
	expect(h.queue.get(a.job.id)?.errorCode).toBe("prepare_failed");
	expect(c.executed).toBe(0);
});

test("a claim that cannot start still settles the owning domain", async () => {
	const h = setup();
	const c = control();
	h.queue.registerHandler(
		fakeHandler(h.store, c, {
			prepareInTransaction: () => {
				throw new Error("prepare boom");
			},
		}),
	);
	const a = await enqueue(h, "a");
	await h.queue.tick();
	expect(h.queue.get(a.job.id)?.errorCode).toBe("prepare_failed");
	expect(item(h.store, "a").state).toBe("failed");
});

test("past-due blocked work does not make the loop spin", async () => {
	const { nextEventAt } = await import("../repository");
	const h = setup();
	const c = control();
	h.queue.registerHandler(fakeHandler(h.store, c));
	await enqueue(h, "a");
	await enqueue(h, "b", { deadlineAtMs: h.clock.t + 100_000 });
	await h.queue.tick();
	await until(() => c.gates.has("a"));
	await h.queue.tick(); // b stays blocked (resource_busy), already available
	const start = h.clock.t;
	expect(h.store.read((db) => nextEventAt(db, start))).toBe(start + 30_000);
	h.clock.t += 40_000;
	expect(h.store.read((db) => nextEventAt(db, h.clock.t))).toBe(
		start + 100_000,
	);
});

test("resource aliases make persisted old jobs and new jobs share the same concurrency limit", async () => {
	const h = setup({
		resources: { "new.res": 1 },
		resourceAliases: { "old.res": "new.res" },
	});
	const c = control();
	h.queue.registerHandler(fakeHandler(h.store, c));
	await enqueue(h, "old", { resourceKey: "old.res" });
	await enqueue(h, "new", { resourceKey: "new.res" });
	await h.queue.tick();
	await until(() => c.calls.length === 1);
	const first = c.calls[0]!.replace("prepare:", "");
	await until(() => c.gates.has(first));
	await h.queue.tick();
	expect(c.calls).toHaveLength(1);
	c.gates.get(first)!.resolve("first");
	await until(() =>
		h.queue.list({}).items.some((j) => j.state === "completed"),
	);
	await h.queue.tick();
	await until(() => c.calls.length === 2);
	expect([...c.calls].sort()).toEqual(["prepare:new", "prepare:old"]);
	c.gates.get(c.calls[1]!.replace("prepare:", ""))!.resolve("second");
	await flush();
});

test("afterCommit hooks of concurrent settlements are not lost", async () => {
	const h = setup({ resources: { "fake.res": 2 } });
	const c = control();
	const committed: string[] = [];
	h.queue.registerHandler(
		fakeHandler(h.store, c, {
			settleInTransaction(tx, claim, _input, outcome) {
				tx.query("UPDATE fake_items SET state=?, result=? WHERE id=?").run(
					"done",
					outcome.type === "success" ? outcome.result : null,
					claim.payload.id,
				);
				committed.push(claim.payload.id);
				// A second settlement starts while this transaction is still open.
				if (claim.payload.id === "a") c.gates.get("b")?.resolve("y");
				return "applied";
			},
			afterCommit: () => {
				committed.push("hook");
			},
		}),
	);
	await enqueue(h, "a");
	await enqueue(h, "b");
	await h.queue.tick();
	await until(() => c.gates.has("a") && c.gates.has("b"));
	c.gates.get("a")?.resolve("x");
	await until(() => committed.filter((x) => x === "hook").length >= 2);
	expect(committed.filter((x) => x === "hook")).toHaveLength(2);
});

test("a runnable job behind more than one page of blocked jobs is still claimed", async () => {
	const h = setup({ limits: { total: 1000, background: 1000, scope: 1000 } });
	const c = control();
	h.queue.registerHandler(fakeHandler(h.store, c));
	await enqueue(h, "first", { lane: "background" });
	await h.queue.tick();
	await until(() => c.gates.has("first")); // holds fake.res
	for (let i = 0; i < 300; i++)
		await enqueue(h, `blocked-${i}`, { lane: "background" });
	await enqueue(h, "other", { lane: "background", resourceKey: "other.res" });
	await h.queue.tick();
	await until(() => c.gates.has("other"));
	expect(c.gates.has("blocked-0")).toBe(false);
	expect(
		h.store.read(
			(db) =>
				db
					.query("SELECT COUNT(*) AS n FROM queue_jobs WHERE state='queued'")
					.get() as { n: number },
		).n,
	).toBe(300);
});
