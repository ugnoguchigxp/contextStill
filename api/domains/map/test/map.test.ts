import { afterEach, expect, test } from "bun:test";
import { makeHandle } from "../../../infrastructure/handle";
import { tempStore } from "../../../infrastructure/sqlite/test-support";
import {
	clustersOfMember,
	edgesFrom,
	edgesTo,
	getCluster,
	getEdge,
	getFacetConcept,
	listClusterMembers,
	listClusters,
	memberDigest,
	memberKey,
	migrations,
	setClusterState,
	setEdgeStatus,
	themeHandle,
	upsertCluster,
	upsertEdge,
	upsertFacetConcept,
	type ClusterInput,
	type EdgeInput,
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

const T1 = "2026-10-30T00:00:00.000Z";
const T2 = "2026-10-30T01:00:00.000Z";
const digests = new Map([
	[memberKey("knowledge", "k1"), "d1"],
	[memberKey("knowledge", "k2"), "d2"],
	[memberKey("episode", "e1"), "de1"],
]);

function cluster(over: Partial<ClusterInput> = {}): ClusterInput {
	const members: ClusterInput["members"] = [
		{ kind: "knowledge", id: "k1", role: "core", similarity: 0.99 },
		{ kind: "knowledge", id: "k2", role: "member", similarity: 0.95 },
	];
	return {
		id: "c1",
		kind: "claim",
		parentId: null,
		level: 0,
		name: "",
		aliases: [],
		description: "",
		summary: {},
		state: "pending",
		algorithm: "avglink.v1|t=0.930|cap=12",
		memberDigest: memberDigest(members, digests),
		members,
		createdAt: T1,
		updatedAt: T1,
		...over,
	};
}

test("memberDigest ignores the order and follows the content digests", () => {
	const a = memberDigest(
		[
			{ kind: "knowledge", id: "k2" },
			{ kind: "knowledge", id: "k1" },
		],
		digests,
	);
	const b = memberDigest(
		[
			{ kind: "knowledge", id: "k1" },
			{ kind: "knowledge", id: "k2" },
		],
		digests,
	);
	expect(a).toBe(b);
	expect(a).toMatch(/^[0-9a-f]{64}$/);
	const changed = new Map(digests).set(memberKey("knowledge", "k2"), "other");
	expect(
		memberDigest(
			[
				{ kind: "knowledge", id: "k1" },
				{ kind: "knowledge", id: "k2" },
			],
			changed,
		),
	).not.toBe(a);
	expect(() =>
		memberDigest([{ kind: "knowledge", id: "nope" }], digests),
	).toThrow("member_digest_missing");
});

test("themeHandle is the th_ handle of the id", () => {
	expect(themeHandle("t1")).toBe(makeHandle("theme", "t1"));
	expect(themeHandle("t1").startsWith("th_")).toBe(true);
});

test("upsertCluster: inserted, then unchanged for the same members, whatever the state", async () => {
	const store = setup();
	expect(await store.write((db) => upsertCluster(db, cluster()))).toBe(
		"inserted",
	);
	await store.write((db) => setClusterState(db, "c1", "distilled", T2));
	// A re-run builds the same cluster as pending again: nothing changes, the state stays.
	expect(
		await store.write((db) => upsertCluster(db, cluster({ updatedAt: T2 }))),
	).toBe("unchanged");
	const row = store.read((db) => getCluster(db, "c1"))!;
	expect(row.state).toBe("distilled");
	expect(row.revision).toBe(1);
	expect(row.handle).toBeNull();
	expect(store.read((db) => listClusterMembers(db, "c1"))).toEqual([
		{ kind: "knowledge", id: "k1", role: "core", similarity: 0.99 },
		{ kind: "knowledge", id: "k2", role: "member", similarity: 0.95 },
	]);
});

test("upsertCluster: a changed membership rewrites the members, takes the state and moves the revision", async () => {
	const store = setup();
	await store.write((db) => upsertCluster(db, cluster()));
	await store.write((db) => setClusterState(db, "c1", "distilled", T2));
	const members: ClusterInput["members"] = [
		{ kind: "knowledge", id: "k1", role: "core", similarity: 1 },
		{ kind: "episode", id: "e1", role: "example", similarity: null },
	];
	const next = cluster({
		members,
		memberDigest: memberDigest(members, digests),
		updatedAt: T2,
	});
	expect(await store.write((db) => upsertCluster(db, next))).toBe("updated");
	const row = store.read((db) => getCluster(db, "c1"))!;
	expect(row.state).toBe("pending");
	expect(row.revision).toBe(2);
	expect(store.read((db) => listClusterMembers(db, "c1"))).toEqual(
		[...members].sort((a, b) => (a.kind < b.kind ? -1 : 1)),
	);
	expect(
		store.read((db) => clustersOfMember(db, "knowledge", "k2", "claim")),
	).toEqual([]);
	expect(
		store.read((db) => clustersOfMember(db, "episode", "e1", "claim")),
	).toEqual(["c1"]);
	expect(
		store.read((db) => clustersOfMember(db, "episode", "e1", "theme")),
	).toEqual([]);
});

test("upsertCluster: a changed description alone keeps the state; a theme gets its handle", async () => {
	const store = setup();
	const theme = cluster({ id: "t1", kind: "theme", name: "DB", level: 1 });
	await store.write((db) => upsertCluster(db, theme));
	await store.write((db) => setClusterState(db, "t1", "distilled", T2));
	const renamed = {
		...theme,
		name: "Database",
		summary: { overview: "x" },
		updatedAt: T2,
	};
	expect(await store.write((db) => upsertCluster(db, renamed))).toBe("updated");
	const row = store.read((db) => getCluster(db, "t1"))!;
	expect(row.state).toBe("distilled");
	expect(row.name).toBe("Database");
	expect(row.summary).toEqual({ overview: "x" });
	expect(row.handle).toBe(themeHandle("t1"));
	expect(
		store.read((db) => listClusters(db, { kind: "theme" })).map((c) => c.id),
	).toEqual(["t1"]);
	expect(store.read((db) => listClusters(db, { kind: "claim" }))).toEqual([]);
	await expect(
		store.write((db) => upsertCluster(db, { ...theme, kind: "claim" })),
	).rejects.toThrow("map_cluster_kind_changed");
});

test("setClusterState reports whether the state changed", async () => {
	const store = setup();
	await store.write((db) => upsertCluster(db, cluster()));
	expect(
		await store.write((db) => setClusterState(db, "c1", "stale", T2)),
	).toBe(true);
	expect(
		await store.write((db) => setClusterState(db, "c1", "stale", T2)),
	).toBe(false);
	expect(
		await store.write((db) => setClusterState(db, "nope", "stale", T2)),
	).toBe(false);
});

const edge = (over: Partial<EdgeInput> = {}): EdgeInput => ({
	src: { kind: "knowledge", id: "canon1" },
	relation: "supersedes",
	dst: { kind: "knowledge", id: "atom1" },
	origin: "llm",
	status: "active",
	confidence: 0.9,
	evidence: { cluster: "c1" },
	extractorVersion: "v1",
	at: T1,
	...over,
});

test("upsertEdge keeps one row per (src, relation, dst) and changes nothing for an equal write", async () => {
	const store = setup();
	expect(await store.write((db) => upsertEdge(db, edge()))).toBe("inserted");
	expect(await store.write((db) => upsertEdge(db, edge({ at: T2 })))).toBe(
		"unchanged",
	);
	expect(
		await store.write((db) =>
			upsertEdge(db, edge({ confidence: 0.5, at: T2 })),
		),
	).toBe("updated");
	await store.write((db) =>
		upsertEdge(
			db,
			edge({ relation: "about", dst: { kind: "theme", id: "t1" } }),
		),
	);
	const out = store.read((db) => edgesFrom(db, "knowledge", "canon1"));
	expect(out.map((e) => e.relation)).toEqual(["supersedes", "about"]);
	const one = out[0]!;
	expect(one.confidence).toBe(0.5);
	expect(one.createdAt).toBe(T1);
	expect(one.updatedAt).toBe(T2);
	expect(one.evidence).toEqual({ cluster: "c1" });
	expect(
		store.read((db) => edgesFrom(db, "knowledge", "canon1", "about")).length,
	).toBe(1);
	expect(
		store
			.read((db) => edgesTo(db, "knowledge", "atom1", "supersedes"))
			.map((e) => e.src.id),
	).toEqual(["canon1"]);
	expect(store.read((db) => edgesTo(db, "theme", "t1")).length).toBe(1);
	expect(
		store.read((db) => db.query("SELECT count(*) AS n FROM map_edges").get()),
	).toEqual({ n: 2 });
});

test("setEdgeStatus retracts an edge once", async () => {
	const store = setup();
	await store.write((db) => upsertEdge(db, edge()));
	const id = store.read((db) => edgesFrom(db, "knowledge", "canon1"))[0]!.id;
	expect(
		await store.write((db) => setEdgeStatus(db, id, "retracted", T2)),
	).toBe(true);
	expect(
		await store.write((db) => setEdgeStatus(db, id, "retracted", T2)),
	).toBe(false);
	expect(store.read((db) => getEdge(db, id))!.status).toBe("retracted");
});

test("upsertFacetConcept: one concept per raw value; a human mapping is not overwritten", async () => {
	const store = setup();
	const f = {
		facetKey: "technologies" as const,
		rawValue: "sqlite3",
		concept: "sqlite",
		themeId: null,
		origin: "deterministic" as const,
		at: T1,
	};
	expect(await store.write((db) => upsertFacetConcept(db, f))).toBe("inserted");
	expect(
		await store.write((db) => upsertFacetConcept(db, { ...f, at: T2 })),
	).toBe("unchanged");
	expect(
		await store.write((db) =>
			upsertFacetConcept(db, { ...f, concept: "SQLite", origin: "llm" }),
		),
	).toBe("updated");
	await store.write((db) =>
		upsertFacetConcept(db, { ...f, concept: "sqlite-db", origin: "human" }),
	);
	expect(
		await store.write((db) =>
			upsertFacetConcept(db, { ...f, concept: "other", origin: "llm" }),
		),
	).toBe("unchanged");
	expect(
		store.read((db) => getFacetConcept(db, "technologies", "sqlite3")),
	).toMatchObject({
		concept: "sqlite-db",
		origin: "human",
		createdAt: T1,
	});
});
