import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import { createQueue, migration } from "..";

const dirs: string[] = [];
const stores: SqliteStore[] = [];
afterEach(async () => {
	for (const s of stores.splice(0)) await s.close().catch(() => {});
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const DAY = 86_400_000;
const NOW = Date.parse("2026-06-01T00:00:00Z");

function setup() {
	const dir = mkdtempSync(join(tmpdir(), "context-still-queue-retention-"));
	dirs.push(dir);
	const store = openStore(join(dir, "db.sqlite3"), [migration]);
	stores.push(store);
	const queue = createQueue(store, {
		now: () => NOW,
		id: () => crypto.randomUUID(),
		sleep: () => new Promise(() => {}),
	});
	queue.registerHandler({
		kind: "ret.job",
		payloadVersions: [1],
		schema: z.object({ n: z.string() }),
		recovery: "interrupt",
		prepareInTransaction: () => ({ status: "ready", input: null }),
		execute: () => new Promise(() => {}),
		settleInTransaction: () => "applied",
		cancelInTransaction: () => {},
	});
	/** Enqueues a job and forces it into `state`, finished `ageDays` ago. */
	const make = (
		n: string,
		state: string,
		ageDays: number | null,
		parentJobId?: string,
	) =>
		store.write((tx) => {
			const { job } = queue.enqueueInTransaction(tx, {
				scope: "ret",
				kind: "ret.job",
				dedupeKey: n,
				payload: { n },
				lane: "background",
				parentJobId,
			});
			tx.query(
				"UPDATE queue_jobs SET state=?, finished_at_ms=? WHERE id=?",
			).run(state, ageDays === null ? null : NOW - ageDays * DAY, job.id);
			tx.query(
				"INSERT INTO queue_attempts (job_id, attempt, owner, started_at_ms) VALUES (?,?,?,?)",
			).run(job.id, 1, "o", NOW - 100 * DAY);
			return job.id;
		});
	const prune = () => store.write((tx) => queue.pruneInTransaction(tx, NOW));
	const ids = () =>
		store.read((db) =>
			(
				db.query("SELECT dedupe_key FROM queue_jobs").all() as {
					dedupe_key: string;
				}[]
			).map((r) => r.dedupe_key),
		);
	const attempts = () =>
		store.read(
			(db) =>
				(
					db.query("SELECT COUNT(*) AS n FROM queue_attempts").get() as {
						n: number;
					}
				).n,
		);
	return { store, queue, make, prune, ids, attempts };
}

test("settled jobs older than 14 days are deleted with their attempts; recent and open ones stay", async () => {
	const h = setup();
	await h.make("old", "completed", 15);
	await h.make("recent", "completed", 13);
	await h.make("open", "queued", null);
	await h.make("newest", "failed", 20); // highest created_seq
	await h.make("last", "queued", null);
	expect(await h.prune()).toBe(2);
	expect(h.ids().sort()).toEqual(["last", "open", "recent"]);
	expect(h.attempts()).toBe(3);
});

test("outcome_unknown jobs are kept for 90 days", async () => {
	const h = setup();
	await h.make("u15", "outcome_unknown", 15);
	await h.make("u89", "outcome_unknown", 89);
	await h.make("u91", "outcome_unknown", 91);
	await h.make("tail", "queued", null);
	await h.prune();
	expect(h.ids().sort()).toEqual(["tail", "u15", "u89"]);
});

test("a parent with a surviving child is kept until the child is deleted", async () => {
	const h = setup();
	const parent = await h.make("parent", "completed", 30);
	await h.make("child", "completed", 5, parent);
	await h.make("tail", "queued", null);
	await h.prune();
	expect(h.ids().sort()).toEqual(["child", "parent", "tail"]);
	await h.store.write((tx) =>
		tx
			.query("UPDATE queue_jobs SET finished_at_ms=? WHERE dedupe_key='child'")
			.run(NOW - 20 * DAY),
	);
	await h.prune();
	expect(h.ids().sort()).toEqual(["parent", "tail"]);
	await h.prune();
	expect(h.ids()).toEqual(["tail"]);
});

test("the row with the highest created_seq is never deleted, however old", async () => {
	const h = setup();
	await h.make("only", "completed", 60);
	expect(await h.prune()).toBe(0);
	expect(h.ids()).toEqual(["only"]);
});

test("after deletion the same dedupe key enqueues a new job", async () => {
	const h = setup();
	const first = await h.make("k", "completed", 20);
	await h.make("tail", "queued", null);
	await h.prune();
	const again = await h.store.write((tx) =>
		h.queue.enqueueInTransaction(tx, {
			scope: "ret",
			kind: "ret.job",
			dedupeKey: "k",
			payload: { n: "k" },
			lane: "background",
		}),
	);
	expect(again.fresh).toBe(true);
	expect(again.job.id).not.toBe(first);
});

test("the limit bounds one pass", async () => {
	const h = setup();
	for (let i = 0; i < 5; i++) await h.make(`j${i}`, "completed", 20 + i);
	await h.make("tail", "queued", null);
	expect(
		await h.store.write((tx) => h.queue.pruneInTransaction(tx, NOW, 2)),
	).toBe(2);
});
