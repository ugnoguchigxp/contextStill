import { afterEach, expect, test } from "bun:test";
import { tempStore } from "../../../infrastructure/sqlite/test-support";
import { insertUsageEvent, migrations, type UsageEventInput } from "../index";

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const dispose of disposers.splice(0)) await dispose();
});
const event = (over: Partial<UsageEventInput> = {}): UsageEventInput => ({
	id: "u1",
	ownerKind: "knowledge",
	ownerId: "k1",
	channel: "compile",
	verdict: "used",
	actor: "agent",
	runRef: "run-1",
	reason: null,
	origin: "legacy_import",
	occurredAt: "2026-10-01T00:00:00.000Z",
	metadata: {},
	...over,
});

test("insertUsageEvent is insert-or-ignore on the id", async () => {
	const t = tempStore(migrations);
	disposers.push(t.dispose);
	expect(await t.store.write((db) => insertUsageEvent(db, event()))).toBe(
		"inserted",
	);
	expect(await t.store.write((db) => insertUsageEvent(db, event()))).toBe(
		"unchanged",
	);
	// An existing event is never rewritten.
	expect(
		await t.store.write((db) =>
			insertUsageEvent(db, event({ verdict: "wrong" })),
		),
	).toBe("unchanged");
	expect(
		t.store.read((db) =>
			db.query("SELECT verdict, run_ref FROM usage_events").all(),
		),
	).toEqual([{ verdict: "used", run_ref: "run-1" }]);
});

test("a bad value is an error, not a silent skip", async () => {
	const t = tempStore(migrations);
	disposers.push(t.dispose);
	for (const bad of [
		event({ id: "a", verdict: "great" as never }),
		event({ id: "b", channel: "web" as never }),
		event({ id: "c", actor: "robot" as never }),
		event({ id: "d", ownerKind: "source" as never }),
		event({ id: "e", origin: "import" as never }),
	])
		await expect(
			t.store.write((db) => insertUsageEvent(db, bad)),
		).rejects.toThrow();
	expect(
		t.store.read((db) =>
			db.query("SELECT count(*) AS n FROM usage_events").get(),
		),
	).toEqual({ n: 0 });
});
