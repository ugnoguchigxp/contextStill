import { afterEach, expect, test } from "bun:test";
import { HANDLE_PATTERN, makeHandle } from "../../../infrastructure/handle";
import { tempStore } from "../../../infrastructure/sqlite/test-support";
import {
	migrations as sourcesMigrations,
	upsertSourceRecord,
} from "../../sources";
import {
	getEpisodeByHandle,
	getEpisodeById,
	listEpisodeSources,
	migrations,
	replaceEpisodeSources,
	upsertEpisode,
	type EpisodeInput,
} from "../index";

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const dispose of disposers.splice(0)) await dispose();
});
function setup() {
	const t = tempStore([...sourcesMigrations, ...migrations]);
	disposers.push(t.dispose);
	return t.store;
}
const T = "2026-10-01T00:00:00.000Z";
const episode = (over: Partial<EpisodeInput> = {}): EpisodeInput => ({
	id: "e1",
	title: "Deploy failure",
	situation: "本番へのデプロイが失敗した",
	intent: "",
	decision: "",
	observations: "ログに接続エラー",
	action: "切り戻しを実施",
	outcome: "復旧した",
	lesson: "切り戻しを先に行う",
	openQuestions: ["原因は何か"],
	outcomeKind: "success",
	eventStart: null,
	eventEnd: null,
	timePrecision: "unknown",
	confidence: 0.8,
	importance: 0.6,
	status: "active",
	space: "coding",
	scope: "global",
	repoKey: null,
	facets: { tools: ["bun"] },
	metadata: { legacy: { id: 1 } },
	createdAt: T,
	updatedAt: T,
	...over,
});
const source = (id: string) => ({
	id,
	kind: "agent_log" as const,
	uri: `vibe_memory:${id}`,
	title: null,
	content: "log",
	space: "coding" as const,
	scope: "global" as const,
	repoKey: null,
	recordedAt: T,
	metadata: {},
	createdAt: T,
	updatedAt: T,
});

test("upsertEpisode: inserted, unchanged, updated; handle, revision, seq", async () => {
	const store = setup();
	expect(await store.write((db) => upsertEpisode(db, episode()))).toBe(
		"inserted",
	);
	const row = store.read((db) => getEpisodeById(db, "e1"))!;
	expect(row.handle).toBe(makeHandle("episode", "e1"));
	expect(row.handle).toMatch(HANDLE_PATTERN);
	expect(row.revision).toBe(1);
	expect(row.openQuestions).toEqual(["原因は何か"]);
	expect(row.facets).toEqual({ tools: ["bun"] });
	expect(row).not.toHaveProperty("metadata");
	const seq = store.read((db) => db.query("SELECT seq FROM episodes").get());
	expect(await store.write((db) => upsertEpisode(db, episode()))).toBe(
		"unchanged",
	);
	expect(
		await store.write((db) =>
			upsertEpisode(
				db,
				episode({
					lesson: "調査を先に行う",
					updatedAt: "2026-10-02T00:00:00.000Z",
				}),
			),
		),
	).toBe("updated");
	const after = store.read((db) => getEpisodeByHandle(db, row.handle))!;
	expect(after.revision).toBe(2);
	expect(after.lesson).toBe("調査を先に行う");
	expect(
		store.read((db) => db.query("SELECT seq FROM episodes").get()),
	).toEqual(seq);
	expect(store.read((db) => getEpisodeById(db, "none"))).toBeNull();
	expect(store.read((db) => getEpisodeByHandle(db, "ep_none"))).toBeNull();
});

test("the FTS follows an upsert (old wording gone, new wording found)", async () => {
	const store = setup();
	await store.write((db) => upsertEpisode(db, episode()));
	const hits = (phrase: string) =>
		store.read((db) =>
			db
				.query("SELECT rowid FROM episodes_fts WHERE episodes_fts MATCH ?")
				.all(`"${phrase}"`),
		).length;
	expect(hits("切り戻し")).toBe(1);
	await store.write((db) =>
		upsertEpisode(
			db,
			episode({
				lesson: "調査を先に行う",
				action: "再起動を実施",
				updatedAt: "2026-10-02T00:00:00.000Z",
			}),
		),
	);
	expect(hits("切り戻し")).toBe(0);
	expect(hits("再起動を")).toBe(1);
});

test("CHECK constraints", async () => {
	const store = setup();
	for (const bad of [
		episode({ id: "a", confidence: 1.5 }),
		episode({ id: "b", importance: -0.1 }),
		episode({ id: "c", status: "gone" as never }),
		episode({ id: "d", outcomeKind: "great" as never }),
		episode({ id: "e", timePrecision: "hour" as never }),
		episode({ id: "f", scope: "global", repoKey: "repo" }),
		episode({ id: "g", space: "work" as never }),
	])
		await expect(store.write((db) => upsertEpisode(db, bad))).rejects.toThrow();
	await store.write((db) =>
		upsertEpisode(db, episode({ id: "ok", scope: "repo", repoKey: "repo" })),
	);
});

test("replaceEpisodeSources replaces the set, needs the source, and lists in order", async () => {
	const store = setup();
	await store.write((db) => {
		upsertSourceRecord(db, source("s1"));
		upsertSourceRecord(db, source("s2"));
		upsertEpisode(db, episode());
	});
	await store.write((db) =>
		replaceEpisodeSources(db, "e1", [
			{ sourceId: "s2", locator: "bytes:0-5", role: "derived_from" },
			{ sourceId: "s1", locator: "", role: "supports" },
			{ sourceId: "s1", locator: "", role: "supports" },
		]),
	);
	expect(store.read((db) => listEpisodeSources(db, "e1"))).toEqual([
		{ sourceId: "s1", locator: "", role: "supports" },
		{ sourceId: "s2", locator: "bytes:0-5", role: "derived_from" },
	]);
	await store.write((db) =>
		replaceEpisodeSources(db, "e1", [
			{ sourceId: "s1", locator: "x", role: "derived_from" },
		]),
	);
	expect(store.read((db) => listEpisodeSources(db, "e1"))).toEqual([
		{ sourceId: "s1", locator: "x", role: "derived_from" },
	]);
	await expect(
		store.write((db) =>
			replaceEpisodeSources(db, "e1", [
				{ sourceId: "ghost", locator: "", role: "supports" },
			]),
		),
	).rejects.toThrow();
	// The failed replace rolled back as a whole.
	expect(store.read((db) => listEpisodeSources(db, "e1"))).toHaveLength(1);
	await expect(
		store.write((db) =>
			replaceEpisodeSources(db, "e1", [
				{ sourceId: "s1", locator: "", role: "refutes" as never },
			]),
		),
	).rejects.toThrow();
	await store.write((db) =>
		db.query("DELETE FROM episodes WHERE id = 'e1'").run(),
	);
	expect(store.read((db) => listEpisodeSources(db, "e1"))).toEqual([]);
});
