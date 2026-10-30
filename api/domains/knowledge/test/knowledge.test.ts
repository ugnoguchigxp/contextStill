import { afterEach, expect, test } from "bun:test";
import { sha256Hex } from "../../../infrastructure/digest";
import { makeHandle } from "../../../infrastructure/handle";
import { tempStore } from "../../../infrastructure/sqlite/test-support";
import { migrations as sourcesMigrations } from "../../sources";
import {
	getKnowledgeByHandle,
	getKnowledgeById,
	listKnowledgeEvidence,
	migrations,
	replaceKnowledgeEvidence,
	upsertKnowledgeItem,
	type EvidenceInput,
	type KnowledgeInput,
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
const item = (over: Partial<KnowledgeInput> = {}): KnowledgeInput => ({
	id: "k1",
	layer: "atom",
	type: "rule",
	polarity: "positive",
	title: "書き込み前に確認する",
	body: "データベースへの書き込みの前に必ずバックアップを取る",
	appliesWhen: ["migration"],
	notAppliesWhen: [],
	steps: [],
	facets: { appliesTo: ["db"] },
	confidence: 0.8,
	importance: 0.7,
	status: "active",
	space: "coding",
	scope: "global",
	repoKey: null,
	validFrom: null,
	validUntil: null,
	provenanceStatus: "resolved",
	metadata: { legacy: { dynamicScore: 3 } },
	createdAt: T,
	updatedAt: T,
	...over,
});
const sourceEvidence = (over: Partial<EvidenceInput> = {}): EvidenceInput => ({
	targetKind: "source",
	targetId: "s1",
	externalRef: null,
	role: "derived_from",
	quote: null,
	confidence: null,
	...over,
});
const externalEvidence = (ref: string): EvidenceInput => ({
	targetKind: "external",
	targetId: null,
	externalRef: ref,
	role: "derived_from",
	quote: "q",
	confidence: 0.5,
});

test("upsertKnowledgeItem: inserted, unchanged, updated; handle, digest, revision, seq", async () => {
	const store = setup();
	expect(await store.write((db) => upsertKnowledgeItem(db, item()))).toBe(
		"inserted",
	);
	const row = store.read((db) => getKnowledgeById(db, "k1"))!;
	expect(row.handle).toBe(makeHandle("knowledge", "k1"));
	expect(row.contentDigest).toBe(
		sha256Hex(
			"書き込み前に確認する\nデータベースへの書き込みの前に必ずバックアップを取る",
		),
	);
	expect(row.revision).toBe(1);
	expect(row.metadata).toEqual({ legacy: { dynamicScore: 3 } });
	expect(row.appliesWhen).toEqual(["migration"]);
	const seq = store.read((db) =>
		db.query("SELECT seq FROM knowledge_items").get(),
	);
	expect(await store.write((db) => upsertKnowledgeItem(db, item()))).toBe(
		"unchanged",
	);
	expect(store.read((db) => getKnowledgeById(db, "k1"))!.revision).toBe(1);
	expect(
		await store.write((db) =>
			upsertKnowledgeItem(
				db,
				item({
					body: "読み出しの前に確認する",
					updatedAt: "2026-10-02T00:00:00.000Z",
				}),
			),
		),
	).toBe("updated");
	const after = store.read((db) => getKnowledgeByHandle(db, row.handle))!;
	expect(after.revision).toBe(2);
	expect(after.contentDigest).not.toBe(row.contentDigest);
	expect(
		store.read((db) => db.query("SELECT seq FROM knowledge_items").get()),
	).toEqual(seq);
	expect(store.read((db) => getKnowledgeById(db, "none"))).toBeNull();
});

test("the FTS follows an upsert", async () => {
	const store = setup();
	await store.write((db) => upsertKnowledgeItem(db, item()));
	const hits = (phrase: string) =>
		store.read((db) =>
			db
				.query("SELECT rowid FROM knowledge_fts WHERE knowledge_fts MATCH ?")
				.all(`"${phrase}"`),
		).length;
	expect(hits("バックアップ")).toBe(1);
	await store.write((db) =>
		upsertKnowledgeItem(
			db,
			item({
				body: "読み出しの前に確認する",
				updatedAt: "2026-10-02T00:00:00.000Z",
			}),
		),
	);
	expect(hits("バックアップ")).toBe(0);
	expect(hits("読み出し")).toBe(1);
});

test("CHECK constraints", async () => {
	const store = setup();
	for (const bad of [
		item({ id: "a", layer: "theme" as never }),
		item({ id: "b", type: "tip" as never }),
		item({ id: "c", polarity: "neutral" as never }),
		item({ id: "d", status: "deleted" as never }),
		item({ id: "e", confidence: 2 }),
		item({ id: "f", scope: "global", repoKey: "r" }),
		item({ id: "g", provenanceStatus: "unknown" as never }),
	])
		await expect(
			store.write((db) => upsertKnowledgeItem(db, bad)),
		).rejects.toThrow();
});

test("replaceKnowledgeEvidence is idempotent and replaces only its origin", async () => {
	const store = setup();
	await store.write((db) => upsertKnowledgeItem(db, item()));
	const imported = [sourceEvidence(), externalEvidence("vibe_memory:abc")];
	const run = () =>
		store.write((db) =>
			replaceKnowledgeEvidence(db, "k1", "legacy_import", imported, T),
		);
	await run();
	const first = store.read((db) => listKnowledgeEvidence(db, "k1"));
	expect(first).toHaveLength(2);
	expect(first[0]).toMatchObject({
		targetKind: "source",
		targetId: "s1",
		origin: "legacy_import",
		role: "derived_from",
	});
	expect(first[1]).toMatchObject({
		targetKind: "external",
		targetId: null,
		externalRef: "vibe_memory:abc",
		quote: "q",
		confidence: 0.5,
	});
	expect(first[0]!.id).toBe(
		`ev_${sha256Hex("k1|source|s1|derived_from|legacy_import").slice(0, 32)}`,
	);
	expect(first[1]!.id).toBe(
		`ev_${sha256Hex("k1|external|vibe_memory:abc|derived_from|legacy_import").slice(0, 32)}`,
	);
	await run();
	await run();
	expect(store.read((db) => listKnowledgeEvidence(db, "k1"))).toEqual(first);
	// Another origin is left alone; replacing with fewer rows removes the rest.
	await store.write((db) =>
		replaceKnowledgeEvidence(
			db,
			"k1",
			"human",
			[sourceEvidence({ role: "supports" })],
			T,
		),
	);
	expect(store.read((db) => listKnowledgeEvidence(db, "k1"))).toHaveLength(3);
	await store.write((db) =>
		replaceKnowledgeEvidence(db, "k1", "legacy_import", [], T),
	);
	const rest = store.read((db) => listKnowledgeEvidence(db, "k1"));
	expect(rest).toHaveLength(1);
	expect(rest[0]!.origin).toBe("human");
	// The same evidence twice in one call is stored once.
	await store.write((db) =>
		replaceKnowledgeEvidence(
			db,
			"k1",
			"pipeline",
			[sourceEvidence(), sourceEvidence()],
			T,
		),
	);
	expect(
		store
			.read((db) => listKnowledgeEvidence(db, "k1"))
			.filter((e) => e.origin === "pipeline"),
	).toHaveLength(1);
});

test("evidence CHECK constraints: external needs a ref and no target", async () => {
	const store = setup();
	await store.write((db) => upsertKnowledgeItem(db, item()));
	const attempt = (e: EvidenceInput) =>
		store.write((db) => replaceKnowledgeEvidence(db, "k1", "pipeline", [e], T));
	await expect(
		attempt({ ...externalEvidence("x"), targetId: "s1" }),
	).rejects.toThrow();
	await expect(
		attempt({ ...externalEvidence("x"), externalRef: null }),
	).rejects.toThrow();
	await expect(attempt(sourceEvidence({ targetId: null }))).rejects.toThrow();
	await expect(attempt(sourceEvidence({ externalRef: "x" }))).rejects.toThrow();
	await expect(attempt(sourceEvidence({ confidence: 2 }))).rejects.toThrow();
	await expect(
		attempt(sourceEvidence({ role: "denies" as never })),
	).rejects.toThrow();
	// Every failed attempt rolled back its delete too.
	await store.write((db) =>
		replaceKnowledgeEvidence(db, "k1", "pipeline", [sourceEvidence()], T),
	);
	await expect(
		attempt({ ...externalEvidence("x"), targetId: "s" }),
	).rejects.toThrow();
	expect(store.read((db) => listKnowledgeEvidence(db, "k1"))).toHaveLength(1);
	// The item must exist; deleting it removes its evidence.
	await expect(
		store.write((db) =>
			replaceKnowledgeEvidence(db, "ghost", "pipeline", [sourceEvidence()], T),
		),
	).rejects.toThrow();
	await store.write((db) => db.query("DELETE FROM knowledge_items").run());
	expect(store.read((db) => listKnowledgeEvidence(db, "k1"))).toEqual([]);
});
