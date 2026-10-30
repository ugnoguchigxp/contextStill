import { afterEach, expect, test } from "bun:test";
import { tempStore } from "../../../infrastructure/sqlite/test-support";
import { migrations as sourcesMigrations } from "../../sources";
import {
	getEpisodeById,
	migrations,
	setEpisodeRetrieval,
	upsertEpisode,
	type EpisodeInput,
} from "../index";

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const dispose of disposers.splice(0)) await dispose();
});
const T1 = "2026-10-30T00:00:00.000Z";
const T2 = "2026-10-30T01:00:00.000Z";
const episode = (over: Partial<EpisodeInput> = {}): EpisodeInput => ({
	id: "e1",
	title: "t",
	situation: "s",
	intent: "",
	decision: "",
	observations: "",
	action: "a",
	outcome: "o",
	lesson: "l",
	openQuestions: [],
	outcomeKind: "success",
	eventStart: null,
	eventEnd: null,
	timePrecision: "unknown",
	confidence: 0.5,
	importance: 0.5,
	status: "active",
	space: "coding",
	scope: "global",
	repoKey: null,
	facets: {},
	metadata: {},
	createdAt: T1,
	updatedAt: T1,
	...over,
});

test("setEpisodeRetrieval changes the retrieval and the revision once; upsert does not reset it", async () => {
	const t = tempStore([...sourcesMigrations, ...migrations]);
	disposers.push(t.dispose);
	const store = t.store;
	await store.write((db) => upsertEpisode(db, episode()));
	expect(store.read((db) => getEpisodeById(db, "e1"))!.retrieval).toBe(
		"searchable",
	);
	expect(
		await store.write((db) => setEpisodeRetrieval(db, "e1", "searchable", T2)),
	).toBe(false);
	expect(
		await store.write((db) =>
			setEpisodeRetrieval(db, "e1", "evidence_only", T2),
		),
	).toBe(true);
	expect(
		await store.write((db) =>
			setEpisodeRetrieval(db, "e1", "evidence_only", T2),
		),
	).toBe(false);
	await store.write((db) =>
		upsertEpisode(db, episode({ lesson: "changed", updatedAt: T2 })),
	);
	expect(store.read((db) => getEpisodeById(db, "e1"))).toMatchObject({
		retrieval: "evidence_only",
		lesson: "changed",
		revision: 3,
	});
	expect(
		await store.write((db) =>
			setEpisodeRetrieval(db, "missing", "evidence_only", T2),
		),
	).toBe(false);
});
