import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { sha256Hex } from "../../../infrastructure/digest";
import { makeHandle } from "../../../infrastructure/handle";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import { tempStore } from "../../../infrastructure/sqlite/test-support";
import {
	migrations as experienceMigrations,
	upsertEpisode,
	type EpisodeInput,
} from "../../experience";
import {
	knowledgeContentDigest,
	migrations as knowledgeMigrations,
	setKnowledgeDisposition,
	upsertKnowledgeItem,
	type KnowledgeInput,
} from "../../knowledge";
import {
	migrations as mapMigrations,
	upsertCluster,
	upsertEdge,
} from "../../map";
import { migrations as sourcesMigrations } from "../../sources";
import {
	ensureVectorSpace,
	migrations as vectorMigrations,
	upsertVector,
	type VectorOrigin,
	type VectorOwnerKind,
	type VectorVerification,
} from "../../vectors";
import { createSearch, SearchError, type SearchRequest } from "../index";

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const dispose of disposers.splice(0)) await dispose();
});

const T = "2026-10-01T00:00:00.000Z";
const DIM = 4;
const descriptor = {
	model: { id: "test-model", revision: "r1", artifactDigest: "d1" },
	dimension: DIM,
};

async function setup() {
	const t = tempStore([
		...sourcesMigrations,
		...experienceMigrations,
		...knowledgeMigrations,
		...vectorMigrations,
		...mapMigrations,
	]);
	disposers.push(t.dispose);
	const store = t.store;
	const spaceKey = await store.write((db) =>
		ensureVectorSpace(db, descriptor, T),
	);
	return { store, spaceKey };
}

const knowledge = (over: Partial<KnowledgeInput> = {}): KnowledgeInput => ({
	id: "k1",
	layer: "atom",
	type: "rule",
	polarity: "positive",
	title: "title",
	body: "body",
	appliesWhen: [],
	notAppliesWhen: [],
	steps: [],
	facets: {},
	confidence: 0.8,
	importance: 0.5,
	status: "active",
	space: "coding",
	scope: "global",
	repoKey: null,
	validFrom: null,
	validUntil: null,
	provenanceStatus: "resolved",
	metadata: {},
	createdAt: T,
	updatedAt: T,
	// A canonical states a situation (5.3); one that no test query matches.
	...(over.layer === "canonical" ? { situation: "◇◇◇" } : {}),
	...over,
});
const episode = (over: Partial<EpisodeInput> = {}): EpisodeInput => ({
	id: "e1",
	title: "title",
	situation: "situation",
	intent: "",
	decision: "",
	observations: "",
	action: "",
	outcome: "",
	lesson: "",
	openQuestions: [],
	outcomeKind: "success",
	eventStart: null,
	eventEnd: null,
	timePrecision: "unknown",
	confidence: 0.6,
	importance: 0.5,
	status: "active",
	space: "coding",
	scope: "global",
	repoKey: null,
	facets: {},
	metadata: {},
	createdAt: T,
	updatedAt: T,
	...over,
});

function seed(
	store: SqliteStore,
	items: KnowledgeInput[],
	episodes: EpisodeInput[] = [],
) {
	return store.write((db) => {
		for (const item of items) upsertKnowledgeItem(db, item);
		for (const e of episodes) upsertEpisode(db, e);
	});
}
/** The digest a fresh vector carries: the owner row's own digest (episodes have none). */
function currentDigest(
	db: Database,
	ownerKind: VectorOwnerKind,
	ownerId: string,
): string {
	if (ownerKind === "knowledge") {
		const row = db
			.query("SELECT content_digest FROM knowledge_items WHERE id = ?")
			.get(ownerId) as { content_digest: string } | null;
		if (row) return row.content_digest;
	}
	return sha256Hex(ownerId);
}
function vec(
	store: SqliteStore,
	spaceKey: string,
	ownerKind: VectorOwnerKind,
	ownerId: string,
	values: number[],
	origin: VectorOrigin = "larm",
	verification: VectorVerification = "unverified",
) {
	return store.write((db) =>
		upsertVector(db, {
			ownerKind,
			ownerId,
			spaceKey,
			contentDigest: currentDigest(db, ownerKind, ownerId),
			vector: Float32Array.from(values),
			origin,
			verification,
			now: T,
		}),
	);
}
const req = (over: Partial<SearchRequest> = {}): SearchRequest => ({
	query: "backup",
	kinds: ["knowledge"],
	spaces: ["coding"],
	limit: 10,
	lanes: ["fts", "short"],
	...over,
});
const ids = (r: { hits: { id: string }[] }) => r.hits.map((h) => h.id);

test("rows out of scope never appear however well they match", async () => {
	const { store, spaceKey } = await setup();
	const strong = { title: "backup backup", body: "backup backup backup" };
	await seed(store, [
		knowledge({ id: "in", title: "backup", body: "weak mention" }),
		knowledge({
			id: "other-repo",
			scope: "repo",
			repoKey: "repo-b",
			...strong,
		}),
		knowledge({
			id: "repo-no-key",
			scope: "repo",
			repoKey: "repo-a",
			...strong,
		}),
		knowledge({ id: "other-space", space: "general", ...strong }),
		knowledge({ id: "retracted", status: "retracted", ...strong }),
		knowledge({ id: "candidate", status: "candidate", ...strong }),
		knowledge({ id: "superseded", status: "superseded", ...strong }),
		knowledge({ id: "canonical", layer: "canonical", ...strong }),
		knowledge({ id: "personal", space: "personal", ...strong }),
	]);
	const search = createSearch({ store, spaceKey });
	// canonical and atom are searched by default; the other rows are out of scope.
	expect(ids(await search.search(req())).sort()).toEqual(["canonical", "in"]);
	expect(ids(await search.search(req({ layers: ["atom"] })))).toEqual(["in"]);
	// repo scope opens only with a matching repoKey.
	const withRepo = await search.search(
		req({ repoKey: "repo-a", layers: ["atom", "canonical"] }),
	);
	expect(ids(withRepo).sort()).toEqual(["canonical", "in", "repo-no-key"]);
	const vectorOnly = createSearch({ store, spaceKey });
	for (const id of [
		"in",
		"other-repo",
		"other-space",
		"retracted",
		"canonical",
	])
		await vec(store, spaceKey, "knowledge", id, [1, 0, 0, 0]);
	const v = await vectorOnly.search(
		req({
			lanes: ["vector"],
			layers: ["atom"],
			queryVector: Float32Array.from([1, 0, 0, 0]),
		}),
	);
	expect(ids(v)).toEqual(["in"]);
});

test("200 strong out-of-scope matches do not push out the one in-scope match", async () => {
	const { store, spaceKey } = await setup();
	const items: KnowledgeInput[] = [
		knowledge({ id: "in", title: "x", body: "a single backup mention" }),
	];
	for (let i = 0; i < 200; i++)
		items.push(
			knowledge({
				id: `out${String(i).padStart(3, "0")}`,
				space: "general",
				title: "backup backup",
				body: "backup backup backup backup",
			}),
		);
	await seed(store, items);
	for (const item of items)
		await vec(
			store,
			spaceKey,
			"knowledge",
			item.id,
			item.id === "in" ? [0.6, 0.8, 0, 0] : [1, 0, 0, 0],
		);
	const search = createSearch({ store, spaceKey });
	const r = await search.search(
		req({
			lanes: ["fts", "short", "vector"],
			queryVector: Float32Array.from([1, 0, 0, 0]),
		}),
	);
	expect(ids(r)).toEqual(["in"]);
	expect(r.candidateCounts).toEqual({ fts: 1, short: 0, vector: 1 });
});

test("Japanese substring of 3+ characters matches via fts, 2 character word via the short lane", async () => {
	const { store, spaceKey } = await setup();
	await seed(store, [
		knowledge({
			id: "k-write",
			title: "確認",
			body: "データベースへの書き込みの前にバックアップを取る",
		}),
		knowledge({ id: "k-rule", title: "命名規則", body: "識別子の付け方" }),
		knowledge({ id: "k-body-rule", title: "別件", body: "規則を守る" }),
		knowledge({ id: "k-none", title: "無関係", body: "天気の話" }),
	]);
	const search = createSearch({ store, spaceKey });
	const write = await search.search(req({ query: "書き込み" }));
	expect(ids(write)).toEqual(["k-write"]);
	expect(write.lanesUsed).toContain("fts");
	const rule = await search.search(req({ query: "規則" }));
	// title match (2 points) outranks a body-only match (1 point).
	expect(ids(rule)).toEqual(["k-rule", "k-body-rule"]);
	expect(rule.lanesUsed).toEqual(["short"]);
	expect(rule.hits[0]!.lanes).toEqual([{ lane: "short", rank: 1, raw: 2 }]);
	expect(rule.hits[1]!.lanes).toEqual([{ lane: "short", rank: 2, raw: 1 }]);
	expect(rule.candidateCounts).toEqual({ fts: 0, short: 2, vector: 0 });
});

test("RRF score follows the formula with the lane weights (hand computed)", async () => {
	const { store, spaceKey } = await setup();
	await seed(store, [
		knowledge({ layer: "canonical", id: "k1", title: "backup", body: "short" }),
		knowledge({
			layer: "canonical",
			id: "k2",
			title: "other",
			body: "backup one two three four",
		}),
		knowledge({
			layer: "canonical",
			id: "k3",
			title: "third",
			body: `backup ${Array.from({ length: 60 }, (_, i) => `w${i}`).join(" ")}`,
		}),
	]);
	// vector ranks: k2 first, k1 second, k3 absent (orthogonal vectors are still ranked, so leave it out)
	await vec(store, spaceKey, "knowledge", "k2", [1, 0, 0, 0]);
	await vec(store, spaceKey, "knowledge", "k1", [0.6, 0.8, 0, 0]);
	const search = createSearch({ store, spaceKey });
	const r = await search.search(
		req({
			lanes: ["fts", "vector"],
			queryVector: Float32Array.from([1, 0, 0, 0]),
		}),
	);
	const byId = Object.fromEntries(r.hits.map((h) => [h.id, h]));
	expect(byId.k1!.lanes.map((l) => [l.lane, l.rank])).toEqual([
		["fts", 1],
		["vector", 2],
	]);
	expect(byId.k2!.lanes.map((l) => [l.lane, l.rank])).toEqual([
		["fts", 2],
		["vector", 1],
	]);
	expect(byId.k3!.lanes.map((l) => [l.lane, l.rank])).toEqual([["fts", 3]]);
	expect(byId.k1!.score).toBeCloseTo(1 / 61 + 1 / 62, 12);
	expect(byId.k2!.score).toBeCloseTo(1 / 62 + 1 / 61, 12);
	expect(byId.k3!.score).toBeCloseTo(1 / 63, 12);
	expect(byId.k2!.lanes[1]!.raw).toBeCloseTo(1, 6);
	// k1 and k2 tie exactly: equal best rank, same kind, so id ascending.
	expect(ids(r)).toEqual(["k1", "k2", "k3"]);
});

test("short lane carries weight 0.5", async () => {
	const { store, spaceKey } = await setup();
	await seed(store, [
		knowledge({
			layer: "canonical",
			id: "a",
			title: "規則",
			body: "規則の本文",
		}),
		knowledge({ layer: "canonical", id: "b", title: "別", body: "規則だけ" }),
	]);
	await vec(store, spaceKey, "knowledge", "b", [1, 0, 0, 0]);
	await vec(store, spaceKey, "knowledge", "a", [0.6, 0.8, 0, 0]);
	const r = await createSearch({ store, spaceKey }).search(
		req({
			query: "規則",
			lanes: ["short", "vector"],
			queryVector: Float32Array.from([1, 0, 0, 0]),
		}),
	);
	const byId = Object.fromEntries(r.hits.map((h) => [h.id, h]));
	expect(byId.a!.score).toBeCloseTo(0.5 / 61 + 1 / 62, 12);
	expect(byId.b!.score).toBeCloseTo(0.5 / 62 + 1 / 61, 12);
	expect(ids(r)).toEqual(["b", "a"]);
});

test("ties break by best lane rank, then knowledge before episode, then id", async () => {
	const { store, spaceKey } = await setup();
	await seed(
		store,
		[
			knowledge({ layer: "canonical", id: "kb", title: "規則", body: "x" }),
			knowledge({ layer: "canonical", id: "ka", title: "規則", body: "x" }),
		],
		[episode({ id: "e0", title: "規則", situation: "x" })],
	);
	const r = await createSearch({ store, spaceKey }).search(
		req({ query: "規則", kinds: ["episode", "knowledge"] }),
	);
	// Lanes rank per kind, so ka (seq 2) and kb tie only by id after rank; the episode ties with rank 1.
	expect(r.hits.map((h) => [h.kind, h.id, h.lanes[0]!.rank])).toEqual([
		["knowledge", "kb", 1],
		["episode", "e0", 1],
		["knowledge", "ka", 2],
	]);
	expect(r.hits[0]!.score).toBeCloseTo(0.5 / 61, 12);
	expect(r.hits[2]!.score).toBeCloseTo(0.5 / 62, 12);
});

test("episodes and knowledge mix, with summaries and handles", async () => {
	const { store, spaceKey } = await setup();
	await seed(
		store,
		[
			knowledge({
				id: "k1",
				title: "backup rule",
				body: "take   a\nbackup",
				type: "procedure",
				polarity: "negative",
			}),
		],
		[
			episode({
				id: "e1",
				title: "backup failed",
				situation: "sit",
				outcome: "",
				lesson: "lesson   text",
			}),
			episode({
				id: "e2",
				title: "backup ok",
				situation: "only situation",
				outcome: "out",
				lesson: "  ",
			}),
		],
	);
	const r = await createSearch({ store, spaceKey }).search(
		req({ kinds: ["knowledge", "episode"], types: ["procedure"] }),
	);
	const byId = Object.fromEntries(r.hits.map((h) => [h.id, h]));
	expect(Object.keys(byId).sort()).toEqual(["e1", "e2", "k1"]);
	expect(byId.k1).toMatchObject({
		kind: "knowledge",
		handle: makeHandle("knowledge", "k1"),
		summary: "take a backup",
		type: "procedure",
		polarity: "negative",
		status: "active",
		space: "coding",
		confidence: 0.8,
	});
	expect(byId.e1).toMatchObject({
		kind: "episode",
		handle: makeHandle("episode", "e1"),
		summary: "lesson text",
		type: null,
		polarity: null,
	});
	expect(byId.e2!.summary).toBe("out");
	// types only restricts knowledge.
	const rule = await createSearch({ store, spaceKey }).search(
		req({ kinds: ["knowledge", "episode"], types: ["rule"] }),
	);
	expect(ids(rule).sort()).toEqual(["e1", "e2"]);
});

test("summary is cut at 280 characters", async () => {
	const { store, spaceKey } = await setup();
	await seed(store, [
		knowledge({ id: "k1", title: "backup", body: "あ".repeat(400) }),
	]);
	const r = await createSearch({ store, spaceKey }).search(req());
	expect([...r.hits[0]!.summary]).toHaveLength(280);
});

test("limit is applied after merging", async () => {
	const { store, spaceKey } = await setup();
	await seed(
		store,
		Array.from({ length: 5 }, (_, i) =>
			knowledge({ id: `k${i}`, title: "backup", body: "x" }),
		),
	);
	const r = await createSearch({ store, spaceKey }).search(req({ limit: 2 }));
	expect(ids(r)).toEqual(["k0", "k1"]);
});

test("vector_unavailable when embedQuery fails or times out; the search still returns", async () => {
	const { store, spaceKey } = await setup();
	await seed(store, [knowledge({ id: "k1", title: "backup", body: "x" })]);
	const failing = createSearch({
		store,
		spaceKey,
		embedQuery: async () => {
			throw new Error("larm_unreachable");
		},
	});
	const r = await failing.search(req({ lanes: undefined }));
	expect(r.degraded).toEqual(["vector_unavailable"]);
	expect(ids(r)).toEqual(["k1"]);
	expect(r.lanesUsed).toEqual(["fts"]);

	let aborted = false;
	const slow = createSearch({
		store,
		spaceKey,
		queryTimeoutMs: 20,
		embedQuery: (_text, signal) =>
			new Promise((_, reject) => {
				signal?.addEventListener("abort", () => {
					aborted = true;
					reject(new Error("aborted"));
				});
			}),
	});
	const s = await slow.search(req({ lanes: undefined }));
	expect(s.degraded).toEqual(["vector_unavailable"]);
	expect(aborted).toBe(true);

	const none = await createSearch({ store, spaceKey }).search(
		req({ lanes: undefined }),
	);
	expect(none.degraded).toEqual(["vector_unavailable"]);

	const wrongSize = await createSearch({ store, spaceKey }).search(
		req({ lanes: undefined, queryVector: Float32Array.from([1, 0]) }),
	);
	expect(wrongSize.degraded).toEqual(["vector_unavailable"]);
});

test("embedQuery is used when no queryVector is given and receives the trimmed query", async () => {
	const { store, spaceKey } = await setup();
	await seed(store, [knowledge({ id: "k1", title: "x", body: "y" })]);
	await vec(store, spaceKey, "knowledge", "k1", [1, 0, 0, 0]);
	const seen: string[] = [];
	const search = createSearch({
		store,
		spaceKey,
		embedQuery: async (text) => {
			seen.push(text);
			return Float32Array.from([1, 0, 0, 0]);
		},
	});
	const r = await search.search(
		req({ query: "  backup  ", lanes: ["vector"] }),
	);
	expect(seen).toEqual(["backup"]);
	expect(ids(r)).toEqual(["k1"]);
	expect(r.degraded).toEqual([]);
	expect(r.lanesUsed).toEqual(["vector"]);
});

test("vector_unverified when only unverified legacy vectors exist; verified ones are used", async () => {
	const { store, spaceKey } = await setup();
	await seed(store, [
		knowledge({ id: "k1", title: "x", body: "y" }),
		knowledge({ id: "k2", title: "x", body: "y" }),
	]);
	await vec(
		store,
		spaceKey,
		"knowledge",
		"k1",
		[1, 0, 0, 0],
		"legacy_import",
		"unverified",
	);
	const search = createSearch({ store, spaceKey });
	const q = {
		lanes: ["vector" as const],
		queryVector: Float32Array.from([1, 0, 0, 0]),
	};
	const r = await search.search(req(q));
	expect(r.hits).toEqual([]);
	expect(r.degraded).toEqual(["vector_unverified"]);
	expect(r.lanesUsed).toEqual([]);

	await vec(
		store,
		spaceKey,
		"knowledge",
		"k1",
		[1, 0, 0, 0],
		"legacy_import",
		"verified",
	);
	const ok = await search.search(req(q));
	expect(ids(ok)).toEqual(["k1"]);
	expect(ok.degraded).toEqual([]);

	await vec(
		store,
		spaceKey,
		"knowledge",
		"k1",
		[1, 0, 0, 0],
		"legacy_import",
		"mismatch",
	);
	const mismatch = await search.search(req(q));
	expect(mismatch.hits).toEqual([]);
	expect(mismatch.degraded).toEqual([]);
});

test("a vector from another space is ignored", async () => {
	const { store, spaceKey } = await setup();
	await seed(store, [knowledge({ id: "k1", title: "x", body: "y" })]);
	const other = await store.write((db) =>
		ensureVectorSpace(
			db,
			{ ...descriptor, model: { ...descriptor.model, revision: "r2" } },
			T,
		),
	);
	await vec(store, other, "knowledge", "k1", [1, 0, 0, 0]);
	const r = await createSearch({ store, spaceKey }).search(
		req({ lanes: ["vector"], queryVector: Float32Array.from([1, 0, 0, 0]) }),
	);
	expect(r.hits).toEqual([]);
});

test("no_lexical_terms falls back to the vector lane alone", async () => {
	const { store, spaceKey } = await setup();
	await seed(store, [
		knowledge({ layer: "canonical", id: "k1", title: "x", body: "y" }),
	]);
	await vec(store, spaceKey, "knowledge", "k1", [1, 0, 0, 0]);
	const search = createSearch({ store, spaceKey });
	const r = await search.search(
		req({
			query: "?",
			lanes: undefined,
			queryVector: Float32Array.from([1, 0, 0, 0]),
		}),
	);
	expect(r.degraded).toEqual(["no_lexical_terms"]);
	expect(ids(r)).toEqual(["k1"]);
	expect(r.lanesUsed).toEqual(["vector"]);
	expect(r.hits[0]!.score).toBeCloseTo(1 / 61, 12);
});

test("degraded reasons come in a stable order", async () => {
	const { store, spaceKey } = await setup();
	const r = await createSearch({ store, spaceKey }).search(
		req({ query: "a", lanes: undefined }),
	);
	expect(r.degraded).toEqual(["vector_unavailable", "no_lexical_terms"]);
	expect(r.hits).toEqual([]);
});

test("personal space is refused; invalid requests are invalid_query", async () => {
	const { store, spaceKey } = await setup();
	const search = createSearch({ store, spaceKey });
	const code = async (r: Partial<SearchRequest>) => {
		try {
			await search.search(req(r));
		} catch (error) {
			expect(error).toBeInstanceOf(SearchError);
			return (error as SearchError).code;
		}
		return null;
	};
	expect(await code({ spaces: ["coding", "personal"] })).toBe(
		"space_not_allowed",
	);
	expect(await code({ query: "   " })).toBe("invalid_query");
	expect(await code({ query: "a".repeat(513) })).toBe("invalid_query");
	expect(await code({ kinds: [] })).toBe("invalid_query");
	expect(await code({ spaces: [] })).toBe("invalid_query");
	expect(await code({ limit: 0 })).toBe("invalid_query");
	expect(await code({ limit: 51 })).toBe("invalid_query");
	expect(await code({ query: "a".repeat(512) })).toBeNull();
});

test("a caller abort propagates", async () => {
	const { store, spaceKey } = await setup();
	const controller = new AbortController();
	controller.abort();
	await expect(
		createSearch({ store, spaceKey }).search(req(), {
			signal: controller.signal,
		}),
	).rejects.toBeDefined();
});

test("FTS special characters in the query are quoted", async () => {
	const { store, spaceKey } = await setup();
	await seed(store, [
		knowledge({ id: "k1", title: 'say "hello" now', body: "x" }),
	]);
	const r = await createSearch({ store, spaceKey }).search(
		req({ query: '"hello" NOT (now) AND* ' }),
	);
	expect(ids(r)).toEqual(["k1"]);
});

test("vector lane skips mismatch/stale vectors and vectors whose digest differs from the item", async () => {
	const { store, spaceKey } = await setup();
	await seed(store, [
		knowledge({ id: "k1", title: "x", body: "y" }),
		knowledge({ id: "k2", title: "x", body: "y" }),
		knowledge({ id: "k3", title: "x", body: "y" }),
		knowledge({ id: "k4", title: "x", body: "y" }),
	]);
	const q = {
		lanes: ["vector" as const],
		queryVector: Float32Array.from([1, 0, 0, 0]),
	};
	const search = createSearch({ store, spaceKey });
	await vec(
		store,
		spaceKey,
		"knowledge",
		"k1",
		[1, 0, 0, 0],
		"larm",
		"mismatch",
	);
	await vec(store, spaceKey, "knowledge", "k2", [1, 0, 0, 0], "larm", "stale");
	await vec(
		store,
		spaceKey,
		"knowledge",
		"k3",
		[1, 0, 0, 0],
		"larm",
		"unverified",
	);
	expect(ids(await search.search(req(q)))).toEqual(["k3"]);

	// The item text changed after k3 was embedded: its vector is out of date.
	await seed(store, [knowledge({ id: "k3", title: "x", body: "changed" })]);
	await vec(
		store,
		spaceKey,
		"knowledge",
		"k4",
		[1, 0, 0, 0],
		"larm",
		"verified",
	);
	await store.write((db) =>
		db.run("UPDATE vectors SET content_digest = 'old' WHERE owner_id = 'k3'"),
	);
	expect(ids(await search.search(req(q)))).toEqual(["k4"]);
});

test("short lane requires half of the terms to hit; 1-2 terms need only one", async () => {
	const { store, spaceKey } = await setup();
	await seed(store, [
		knowledge({ id: "k-all", title: "ab cd ef", body: "z" }),
		knowledge({ id: "k-two", title: "ab", body: "cd" }),
		knowledge({ id: "k-one", title: "ab", body: "z" }),
	]);
	const search = createSearch({ store, spaceKey });
	const three = await search.search(
		req({ query: "ab cd ef", lanes: ["short"] }),
	);
	// 3 terms: at least ceil(3/2) = 2 distinct terms must hit; k-one (1 term) is out.
	expect(ids(three)).toEqual(["k-all", "k-two"]);
	const two = await search.search(req({ query: "ab cd", lanes: ["short"] }));
	// 2 terms: one hit is enough, ordered by points then hits.
	expect(ids(two)).toEqual(["k-all", "k-two", "k-one"]);
	const one = await search.search(req({ query: "ef", lanes: ["short"] }));
	expect(ids(one)).toEqual(["k-all"]);
});

const canonical = (over: Partial<KnowledgeInput> = {}) =>
	knowledge({
		layer: "canonical",
		situation: "when the nightly job runs",
		...over,
	});

test("evidence_only and superseded rows never appear; includeSuperseded lifts both", async () => {
	const { store, spaceKey } = await setup();
	const strong = { title: "backup backup", body: "backup backup backup" };
	await seed(
		store,
		[
			knowledge({ id: "in", title: "backup", body: "weak mention" }),
			knowledge({ id: "evidence", ...strong }),
			knowledge({ id: "old", ...strong }),
			canonical({ id: "canon-evidence", ...strong }),
		],
		[
			episode({ id: "ep-in", title: "backup", situation: "x" }),
			episode({
				id: "ep-evidence",
				title: "backup backup",
				situation: "backup",
			}),
		],
	);
	await store.write((db) => {
		setKnowledgeDisposition(db, "evidence", {
			retrieval: "evidence_only",
			updatedAt: T,
		});
		setKnowledgeDisposition(db, "canon-evidence", {
			retrieval: "evidence_only",
			updatedAt: T,
		});
		setKnowledgeDisposition(db, "old", { status: "superseded", updatedAt: T });
		db.query(
			"UPDATE episodes SET retrieval = 'evidence_only' WHERE id = ?",
		).run("ep-evidence");
	});
	await vec(store, spaceKey, "knowledge", "evidence", [1, 0, 0, 0]);
	const search = createSearch({ store, spaceKey });
	const base = req({
		kinds: ["knowledge", "episode"],
		lanes: ["fts", "short"],
	});
	expect(ids(await search.search(base)).sort()).toEqual(["ep-in", "in"]);
	const vector = await search.search(
		req({ lanes: ["vector"], queryVector: Float32Array.from([1, 0, 0, 0]) }),
	);
	expect(ids(vector)).toEqual([]);
	const lifted = await search.search({ ...base, includeSuperseded: true });
	expect(ids(lifted).sort()).toEqual([
		"canon-evidence",
		"ep-evidence",
		"ep-in",
		"evidence",
		"in",
		"old",
	]);
	expect(lifted.hits.find((h) => h.id === "old")!.status).toBe("superseded");
});

test("a canonical whose words are only in the situation is found by fts and short", async () => {
	const { store, spaceKey } = await setup();
	await seed(store, [
		canonical({
			id: "c",
			title: "別件",
			body: "本文に語はない",
			situation: "データベースの移行とバックアップ",
		}),
		knowledge({ id: "a", title: "別件", body: "本文に語はない" }),
	]);
	const search = createSearch({ store, spaceKey });
	const fts = await search.search(
		req({ query: "データベース", lanes: ["fts"] }),
	);
	expect(ids(fts)).toEqual(["c"]);
	const short = await search.search(req({ query: "移行", lanes: ["short"] }));
	expect(ids(short)).toEqual(["c"]);
	expect(short.hits[0]!.lanes[0]!.raw).toBe(2);
	expect(short.hits[0]!.situation).toBe("データベースの移行とバックアップ");
});

test("bm25 weighs situation (2.5) above title (2.0) above body (1.0)", async () => {
	const { store, spaceKey } = await setup();
	const filler = "alpha beta gamma delta epsilon";
	await seed(store, [
		canonical({
			id: "in-body",
			title: filler,
			situation: filler,
			body: `${filler} backup`,
		}),
		canonical({
			id: "in-title",
			title: `${filler} backup`,
			situation: filler,
			body: filler,
		}),
		canonical({
			id: "in-situation",
			title: filler,
			situation: `${filler} backup`,
			body: filler,
		}),
	]);
	const r = await createSearch({ store, spaceKey }).search(
		req({ lanes: ["fts"] }),
	);
	expect(ids(r)).toEqual(["in-situation", "in-title", "in-body"]);
	const raw = r.hits.map((h) => h.lanes[0]!.raw);
	expect(raw[0]!).toBeGreaterThan(raw[1]!);
	expect(raw[1]!).toBeGreaterThan(raw[2]!);
});

test("atom is scaled by 0.8 and a canonical wins ties", async () => {
	const { store, spaceKey } = await setup();
	await seed(store, [
		knowledge({ id: "a", title: "規則", body: "x" }),
		canonical({ id: "c", title: "規則", body: "x", situation: "y" }),
	]);
	const search = createSearch({ store, spaceKey });
	const r = await search.search(req({ query: "規則", lanes: ["short"] }));
	// atom "a" ranks first inside the lane (seq order), yet the canonical leads after the 0.8.
	const byId = Object.fromEntries(r.hits.map((h) => [h.id, h]));
	expect(byId.a!.lanes[0]!.rank).toBe(1);
	expect(byId.c!.lanes[0]!.rank).toBe(2);
	expect(byId.a!.score).toBeCloseTo((0.5 / 61) * 0.8, 12);
	expect(byId.c!.score).toBeCloseTo(0.5 / 62, 12);
	expect(ids(r)).toEqual(["c", "a"]);
	// An exact tie across layers: atom at rank 20 (0.8 / 80) equals canonical at rank 40 (1 / 100).
	const items: KnowledgeInput[] = [];
	for (let n = 1; n <= 40; n++)
		items.push(
			n === 20
				? knowledge({ id: "tie-a", title: "同点", body: "x" })
				: n === 40
					? canonical({ id: "tie-c", title: "同点", body: "x" })
					: knowledge({
							id: `f${String(n).padStart(2, "0")}`,
							title: "同点",
							body: "x",
						}),
		);
	await seed(store, items);
	const tie = await search.search(
		req({ query: "同点", lanes: ["short"], limit: 50 }),
	);
	const order = ids(tie);
	expect(tie.hits.find((h) => h.id === "tie-a")!.lanes[0]!.rank).toBe(20);
	expect(tie.hits.find((h) => h.id === "tie-c")!.lanes[0]!.rank).toBe(40);
	expect(order.indexOf("tie-c")).toBeLessThan(order.indexOf("tie-a"));
});

test("canonical summary is situation (120) + ' — ' + body, cut at 280", async () => {
	const { store, spaceKey } = await setup();
	await seed(store, [
		canonical({
			id: "c",
			title: "backup",
			situation: "s".repeat(200),
			body: "b".repeat(400),
		}),
		knowledge({ id: "a", title: "backup", body: "atom body" }),
	]);
	const r = await createSearch({ store, spaceKey }).search(req());
	const c = r.hits.find((h) => h.id === "c")!;
	expect(c.summary).toBe(`${"s".repeat(120)} — ${"b".repeat(280 - 123)}`);
	expect([...c.summary]).toHaveLength(280);
	const a = r.hits.find((h) => h.id === "a")!;
	expect(a.summary).toBe("atom body");
	expect(a.layer).toBe("atom");
	expect(a.situation).toBe("");
});

test("vector lane matches the new digest (situation included), not the title+body one", async () => {
	const { store, spaceKey } = await setup();
	await seed(store, [
		canonical({ id: "fresh", title: "t1", body: "b1", situation: "s1" }),
		canonical({ id: "old", title: "t2", body: "b2", situation: "s2" }),
	]);
	await store.write((db) => {
		for (const [id, t, b, s, digestSituation] of [
			["fresh", "t1", "b1", "s1", "s1"],
			["old", "t2", "b2", "s2", ""],
		] as const) {
			void s;
			upsertVector(db, {
				ownerKind: "knowledge",
				ownerId: id,
				spaceKey,
				contentDigest: knowledgeContentDigest(t, b, digestSituation),
				vector: Float32Array.from([1, 0, 0, 0]),
				origin: "larm",
				verification: "unverified",
				now: T,
			});
		}
	});
	const r = await createSearch({ store, spaceKey }).search(
		req({ lanes: ["vector"], queryVector: Float32Array.from([1, 0, 0, 0]) }),
	);
	expect(ids(r)).toEqual(["fresh"]);
});

async function seedThemes(store: SqliteStore) {
	await seed(store, [
		knowledge({ id: "k-low", title: "backup", body: "x" }),
		knowledge({ id: "k-high", title: "backup", body: "y" }),
		canonical({ id: "k-other", title: "backup", body: "z" }),
		knowledge({ id: "k-none", title: "backup", body: "w" }),
	]);
	await store.write((db) => {
		const theme = (id: string, level: 0 | 1 | 2, parentId: string | null) =>
			upsertCluster(db, {
				id,
				kind: "theme",
				parentId,
				level,
				name: id,
				aliases: [],
				description: "",
				summary: {},
				state: "distilled",
				algorithm: "test",
				memberDigest: "d",
				members: [],
				createdAt: T,
				updatedAt: T,
			});
		theme("top", 1, null);
		theme("sub", 2, "top");
		theme("elsewhere", 2, null);
		const edge = (
			src: string,
			relation: "about" | "broader",
			dst: string,
			srcKind: "knowledge" | "theme" = "knowledge",
		) =>
			upsertEdge(db, {
				src: { kind: srcKind, id: src },
				relation,
				dst: { kind: "theme", id: dst },
				origin: "clustering",
				status: "active",
				confidence: 0.9,
				evidence: {},
				extractorVersion: "test",
				at: T,
			});
		edge("sub", "broader", "top", "theme");
		edge("k-low", "about", "sub");
		edge("k-low", "about", "top");
		edge("k-high", "about", "top");
		edge("k-other", "about", "elsewhere");
	});
}

test("theme narrows to the theme and its descendants; hits carry up to 3 theme ids, level 2 first", async () => {
	const { store, spaceKey } = await setup();
	await seedThemes(store);
	const search = createSearch({ store, spaceKey });
	const all = await search.search(req());
	expect(all.hits.find((h) => h.id === "k-low")!.themes).toEqual(["sub"]);
	expect(all.hits.find((h) => h.id === "k-high")!.themes).toEqual(["top"]);
	expect(all.hits.find((h) => h.id === "k-none")!.themes).toEqual([]);
	expect(all.degraded).not.toContain("theme_unavailable");
	const top = await search.search(req({ theme: "top" }));
	expect(ids(top).sort()).toEqual(["k-high", "k-low"]);
	const sub = await search.search(req({ theme: "sub" }));
	expect(ids(sub)).toEqual(["k-low"]);
	const unknown = await search.search(req({ theme: "nope" }));
	expect(ids(unknown)).toEqual([]);
});

test("an empty theme table gives theme_unavailable and no narrowing", async () => {
	const { store, spaceKey } = await setup();
	await seed(store, [knowledge({ id: "k", title: "backup", body: "x" })]);
	const r = await createSearch({ store, spaceKey }).search(
		req({ theme: "top" }),
	);
	expect(ids(r)).toEqual(["k"]);
	expect(r.degraded).toEqual(["theme_unavailable"]);
});
