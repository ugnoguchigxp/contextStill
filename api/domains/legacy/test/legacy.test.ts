import { afterEach, expect, test } from "bun:test";
import { tempStore } from "../../../infrastructure/sqlite/test-support";
import {
	finishImportRun,
	getImportMap,
	migrations,
	putImportMap,
	resolveLegacyRef,
	startImportRun,
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
const T = "2026-10-30T00:00:00.000Z";
const ID = "0c6a8f0e-1d0b-4c8e-a7b1-2f3e4d5c6b7a";

test("import runs are recorded and the map points legacy ids to new ones", async () => {
	const store = setup();
	await store.write((db) => {
		startImportRun(db, {
			id: "run1",
			importerVersion: "legacy-import.v1",
			snapshotFingerprint: "fp",
			startedAt: T,
		});
		putImportMap(db, {
			legacyTable: "knowledge_items",
			legacyId: ID,
			targetTable: "knowledge_items",
			targetId: ID,
			legacyDigest: "d1",
			importRunId: "run1",
			importedAt: T,
		});
	});
	expect(
		store.read((db) =>
			db.query("SELECT status, finished_at FROM legacy_import_runs").get(),
		),
	).toEqual({ status: "running", finished_at: null });
	await store.write((db) =>
		finishImportRun(db, "run1", "succeeded", { b: 1, a: 2 }, T),
	);
	expect(
		store.read((db) =>
			db
				.query(
					"SELECT status, finished_at, report_json FROM legacy_import_runs",
				)
				.get(),
		),
	).toEqual({
		status: "succeeded",
		finished_at: T,
		report_json: '{"a":2,"b":1}',
	});
	expect(store.read((db) => getImportMap(db, "knowledge_items", ID))).toEqual({
		targetTable: "knowledge_items",
		targetId: ID,
		legacyDigest: "d1",
	});
	expect(store.read((db) => getImportMap(db, "episode_cards", ID))).toBeNull();
});

test("putImportMap updates the digest and run of an existing row", async () => {
	const store = setup();
	await store.write((db) => {
		startImportRun(db, {
			id: "run1",
			importerVersion: "v",
			snapshotFingerprint: "fp",
			startedAt: T,
		});
		startImportRun(db, {
			id: "run2",
			importerVersion: "v",
			snapshotFingerprint: "fp",
			startedAt: T,
		});
		const row = {
			legacyTable: "sources" as const,
			legacyId: "s",
			targetTable: "source_records",
			targetId: "s",
			legacyDigest: "d1",
			importRunId: "run1",
			importedAt: T,
		};
		putImportMap(db, row);
		putImportMap(db, { ...row, legacyDigest: "d2", importRunId: "run2" });
	});
	expect(
		store.read((db) =>
			db.query("SELECT count(*) AS n FROM legacy_import_map").get(),
		),
	).toEqual({ n: 1 });
	expect(
		store.read((db) => getImportMap(db, "sources", "s"))?.legacyDigest,
	).toBe("d2");
	expect(
		store.read((db) =>
			db.query("SELECT import_run_id FROM legacy_import_map").get(),
		),
	).toEqual({ import_run_id: "run2" });
});

test("a map row needs its run, and a run status is checked", async () => {
	const store = setup();
	await expect(
		store.write((db) =>
			putImportMap(db, {
				legacyTable: "sources",
				legacyId: "s",
				targetTable: "t",
				targetId: "t",
				legacyDigest: "d",
				importRunId: "ghost",
				importedAt: T,
			}),
		),
	).rejects.toThrow();
	await store.write((db) =>
		startImportRun(db, {
			id: "run1",
			importerVersion: "v",
			snapshotFingerprint: "fp",
			startedAt: T,
		}),
	);
	await expect(
		store.write((db) => finishImportRun(db, "run1", "done" as never, {}, T)),
	).rejects.toThrow();
});

test("resolveLegacyRef turns legacy:<table>:<id> into the new id", async () => {
	const store = setup();
	await store.write((db) => {
		startImportRun(db, {
			id: "run1",
			importerVersion: "v",
			snapshotFingerprint: "fp",
			startedAt: T,
		});
		putImportMap(db, {
			legacyTable: "knowledge_items",
			legacyId: ID,
			targetTable: "knowledge_items",
			targetId: "new-1",
			legacyDigest: "d",
			importRunId: "run1",
			importedAt: T,
		});
		putImportMap(db, {
			legacyTable: "episode_cards",
			legacyId: ID,
			targetTable: "episodes",
			targetId: "new-2",
			legacyDigest: "d",
			importRunId: "run1",
			importedAt: T,
		});
	});
	const resolve = (ref: string) =>
		store.read((db) => resolveLegacyRef(db, ref));
	expect(resolve(`legacy:knowledge_items:${ID}`)).toEqual({
		targetTable: "knowledge_items",
		targetId: "new-1",
	});
	expect(resolve(`legacy:episode_cards:${ID}`)).toEqual({
		targetTable: "episodes",
		targetId: "new-2",
	});
	expect(
		resolve("legacy:knowledge_items:ffffffff-ffff-ffff-ffff-ffffffffffff"),
	).toBeNull();
	for (const bad of [
		"",
		"knowledge_items:x",
		`legacy:nope:${ID}`,
		"legacy:knowledge_items:",
		`other:knowledge_items:${ID}`,
	])
		expect(resolve(bad)).toBeNull();
});
