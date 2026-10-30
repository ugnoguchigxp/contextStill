import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
	openStore,
	WriterBusyError,
	type SqliteStore,
} from "../../../infrastructure/sqlite";
import { createQueue, migration, type HandlerDefinition } from "..";
import { waitFor as until } from "../../../infrastructure/wait-for";

const dirs: string[] = [];
const stores: SqliteStore[] = [];
afterEach(async () => {
	for (const s of stores.splice(0)) await s.close().catch(() => {});
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const yieldTurn = () => new Promise((r) => setImmediate(r));
function realStore() {
	const dir = mkdtempSync(join(tmpdir(), "context-still-overload-"));
	dirs.push(dir);
	const store = openStore(join(dir, "db.sqlite3"), [
		"CREATE TABLE t (id INTEGER PRIMARY KEY)",
		migration,
	]);
	stores.push(store);
	return store;
}

test("reserved writes are accepted after general writes fill the writer queue", async () => {
	const store = realStore();
	const general = Array.from({ length: 64 }, () => store.write(() => 1));
	await expect(store.write(() => 1)).rejects.toBeInstanceOf(WriterBusyError);
	const reserved = store.write(() => "settled", { reserved: true });
	await expect(reserved).resolves.toBe("settled");
	await Promise.all(general);
	// The reserved lane is bounded too.
	const flood = Array.from({ length: 64 + 32 }, () =>
		store.write(() => 1, { reserved: true }),
	);
	await expect(store.write(() => 1, { reserved: true })).rejects.toBeInstanceOf(
		WriterBusyError,
	);
	await Promise.all(flood);
});

/** Emulates an overloaded writer: general writes always fail, reserved ones fail `busyReserved` times. */
function overloaded(store: SqliteStore) {
	const state = { saturated: false, busyReserved: 0 };
	const wrapped: SqliteStore = {
		...store,
		write: (operation, options) => {
			if (state.saturated) {
				if (!options?.reserved) return Promise.reject(new WriterBusyError());
				if (state.busyReserved > 0) {
					state.busyReserved--;
					return Promise.reject(new WriterBusyError());
				}
			}
			return store.write(operation, options);
		},
	};
	return { wrapped, state };
}

function harness() {
	const real = realStore();
	const { wrapped, state } = overloaded(real);
	const queue = createQueue(wrapped, {
		now: () => 1_000_000,
		id: () => crypto.randomUUID(),
		// Short settle backoffs elapse at once; the heartbeat and poll waits never do.
		sleep: (ms) => (ms < 1_000 ? Promise.resolve() : new Promise(() => {})),
		random: () => 0,
	});
	const gates = new Map<string, (v: string) => void>();
	const handler: HandlerDefinition<{ id: string }, { id: string }, string> = {
		kind: "fake.work",
		payloadVersions: [1],
		schema: z.object({ id: z.string() }),
		recovery: "interrupt",
		resourceKey: "fake.res",
		prepareInTransaction: (_tx, claim) => ({
			status: "ready",
			input: { id: claim.payload.id },
		}),
		execute: (input) =>
			new Promise<string>((resolve) => gates.set(input.id, resolve)),
		settleInTransaction: () => "applied",
		cancelInTransaction: () => {},
	};
	queue.registerHandler(handler);
	return { real, state, queue, gates };
}

async function runToGate(h: ReturnType<typeof harness>, id: string) {
	const { job } = await h.queue.enqueue({
		scope: "test",
		kind: "fake.work",
		dedupeKey: id,
		payload: { id },
		lane: "interactive",
	});
	await h.queue.tick();
	await until(() => h.gates.has(id));
	return job.id;
}

test("a finished job settles through the reserved lane while general writes are refused", async () => {
	const h = harness();
	const jobId = await runToGate(h, "a");
	h.state.saturated = true;
	h.gates.get("a")?.("answer");
	await until(() => h.queue.get(jobId)?.state === "completed");
	expect(h.queue.get(jobId)?.state).toBe("completed");
});

test("settlement retries a briefly full writer instead of discarding the finished result", async () => {
	const h = harness();
	const jobId = await runToGate(h, "a");
	h.state.saturated = true;
	h.state.busyReserved = 3;
	h.gates.get("a")?.("answer");
	await until(() => h.queue.get(jobId)?.state === "completed");
	expect(h.state.busyReserved).toBe(0);
});

test("a writer that stays full only delays settlement; the job is not marked failed by it", async () => {
	const h = harness();
	const jobId = await runToGate(h, "a");
	h.state.saturated = true;
	h.state.busyReserved = 1_000;
	h.gates.get("a")?.("answer");
	// 1 attempt + 5 bounded retries, then the lease sweep decides.
	await until(() => h.state.busyReserved <= 1_000 - 6);
	await yieldTurn();
	await yieldTurn();
	expect(h.queue.get(jobId)?.state).toBe("running");
	expect(h.state.busyReserved).toBe(1_000 - 6);
});
