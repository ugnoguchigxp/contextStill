import { afterEach, expect, test } from "bun:test";
import { tempStore } from "../../../infrastructure/sqlite/test-support";
import {
	findSourceByUri,
	getSourceFragment,
	getSourceRecord,
	migrations,
	upsertSourceFragment,
	upsertSourceRecord,
	type SourceFragmentInput,
	type SourceRecordInput,
} from "../index";

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const dispose of disposers.splice(0)) await dispose();
});
function setup() {
	const t = tempStore(migrations);
	disposers.push(t.dispose);
	return t.store;
}

const record = (over: Partial<SourceRecordInput> = {}): SourceRecordInput => ({
	id: "s1",
	kind: "document",
	uri: "wiki/a.md",
	title: "Title",
	content: "body one",
	space: "coding",
	scope: "global",
	repoKey: null,
	recordedAt: "2026-10-01T00:00:00.000Z",
	metadata: { b: 2, a: 1 },
	createdAt: "2026-10-01T00:00:00.000Z",
	updatedAt: "2026-10-01T00:00:00.000Z",
	...over,
});
const fragment = (
	over: Partial<SourceFragmentInput> = {},
): SourceFragmentInput => ({
	id: "f1",
	sourceId: "s1",
	locator: "bytes:0-8",
	byteStart: 0,
	byteEnd: 8,
	heading: "H",
	content: "body one",
	createdAt: "2026-10-01T00:00:00.000Z",
	...over,
});

test("upsertSourceRecord: inserted, unchanged, updated; revision and seq", async () => {
	const store = setup();
	expect(await store.write((db) => upsertSourceRecord(db, record()))).toBe(
		"inserted",
	);
	const first = store.read((db) =>
		db.query("SELECT * FROM source_records").get(),
	) as any;
	expect(first.revision).toBe(1);
	expect(first.content_digest).toMatch(/^[0-9a-f]{64}$/);
	expect(first.metadata_json).toBe('{"a":1,"b":2}');
	// Key order of metadata does not make a difference.
	expect(
		await store.write((db) =>
			upsertSourceRecord(db, record({ metadata: { a: 1, b: 2 } })),
		),
	).toBe("unchanged");
	expect(
		store.read((db) => db.query("SELECT revision FROM source_records").get()),
	).toEqual({ revision: 1 });
	expect(
		await store.write((db) =>
			upsertSourceRecord(
				db,
				record({ content: "body two", updatedAt: "2026-10-02T00:00:00.000Z" }),
			),
		),
	).toBe("updated");
	const second = store.read((db) =>
		db.query("SELECT * FROM source_records").get(),
	) as any;
	expect(second.revision).toBe(2);
	expect(second.seq).toBe(first.seq);
	expect(second.content_digest).not.toBe(first.content_digest);
	expect(store.read((db) => getSourceRecord(db, "s1"))).toEqual({
		id: "s1",
		kind: "document",
		uri: "wiki/a.md",
		title: "Title",
		content: "body two",
		space: "coding",
		scope: "global",
		repoKey: null,
		recordedAt: "2026-10-01T00:00:00.000Z",
	});
	expect(store.read((db) => getSourceRecord(db, "none"))).toBeNull();
});

test("(kind, uri) finds the source and is unique", async () => {
	const store = setup();
	await store.write((db) => upsertSourceRecord(db, record()));
	expect(
		store.read((db) => findSourceByUri(db, "document", "wiki/a.md")),
	).toEqual({ id: "s1" });
	expect(
		store.read((db) => findSourceByUri(db, "web", "wiki/a.md")),
	).toBeNull();
	await expect(
		store.write((db) => upsertSourceRecord(db, record({ id: "s2" }))),
	).rejects.toThrow();
	await store.write((db) =>
		upsertSourceRecord(db, record({ id: "s2", kind: "web" })),
	);
});

test("CHECK constraints: a repo_key only with scope repo; unknown kind and space", async () => {
	const store = setup();
	await expect(
		store.write((db) =>
			upsertSourceRecord(db, record({ scope: "global", repoKey: "r" })),
		),
	).rejects.toThrow();
	await store.write((db) =>
		upsertSourceRecord(db, record({ scope: "repo", repoKey: "r" })),
	);
	await expect(
		store.write((db) =>
			upsertSourceRecord(
				db,
				record({ id: "x", uri: "x", kind: "chat" as never }),
			),
		),
	).rejects.toThrow();
	await expect(
		store.write((db) =>
			upsertSourceRecord(
				db,
				record({ id: "y", uri: "y", space: "other" as never }),
			),
		),
	).rejects.toThrow();
});

test("fragments: upsert, lookup, byte range checks, cascade", async () => {
	const store = setup();
	await store.write((db) => upsertSourceRecord(db, record()));
	expect(await store.write((db) => upsertSourceFragment(db, fragment()))).toBe(
		"inserted",
	);
	expect(await store.write((db) => upsertSourceFragment(db, fragment()))).toBe(
		"unchanged",
	);
	expect(
		await store.write((db) =>
			upsertSourceFragment(db, fragment({ heading: "H2" })),
		),
	).toBe("updated");
	expect(store.read((db) => getSourceFragment(db, "f1"))).toEqual({
		id: "f1",
		sourceId: "s1",
		locator: "bytes:0-8",
		heading: "H2",
		content: "body one",
	});
	await expect(
		store.write((db) =>
			upsertSourceFragment(
				db,
				fragment({ id: "f2", locator: "l2", byteStart: 5, byteEnd: null }),
			),
		),
	).rejects.toThrow();
	await expect(
		store.write((db) =>
			upsertSourceFragment(
				db,
				fragment({ id: "f3", locator: "l3", byteStart: 9, byteEnd: 3 }),
			),
		),
	).rejects.toThrow();
	await store.write((db) =>
		upsertSourceFragment(
			db,
			fragment({ id: "f4", locator: "l4", byteStart: null, byteEnd: null }),
		),
	);
	// A fragment needs its source.
	await expect(
		store.write((db) =>
			upsertSourceFragment(
				db,
				fragment({ id: "f5", sourceId: "ghost", locator: "l5" }),
			),
		),
	).rejects.toThrow();
	await store.write((db) =>
		db.query("DELETE FROM source_records WHERE id = 's1'").run(),
	);
	expect(store.read((db) => getSourceFragment(db, "f1"))).toBeNull();
});
