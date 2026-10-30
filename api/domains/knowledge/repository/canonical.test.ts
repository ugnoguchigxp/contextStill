import { afterEach, expect, test } from "bun:test";
import { sha256Hex } from "../../../infrastructure/digest";
import { tempStore } from "../../../infrastructure/sqlite/test-support";
import { migrations as sourcesMigrations } from "../../sources";
import {
	getKnowledgeById,
	knowledgeContentDigest,
	listSupersededBy,
	migrations,
	replaceKnowledgeEvidence,
	setKnowledgeDisposition,
	upsertKnowledgeItem,
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
const T1 = "2026-10-30T00:00:00.000Z";
const T2 = "2026-10-30T01:00:00.000Z";
const item = (over: Partial<KnowledgeInput> = {}): KnowledgeInput => ({
	id: "k1",
	layer: "atom",
	type: "rule",
	polarity: "positive",
	title: "書き込み前に確認する",
	body: "データベースへの書き込みの前に必ずバックアップを取る",
	appliesWhen: [],
	notAppliesWhen: [],
	steps: [],
	facets: {},
	confidence: 0.8,
	importance: 0.7,
	status: "active",
	space: "coding",
	scope: "global",
	repoKey: null,
	validFrom: null,
	validUntil: null,
	provenanceStatus: "resolved",
	metadata: {},
	createdAt: T1,
	updatedAt: T1,
	...over,
});

test("knowledgeContentDigest: no situation is the N1 value, a situation comes first", () => {
	expect(knowledgeContentDigest("T", "B")).toBe(sha256Hex("T\nB"));
	expect(knowledgeContentDigest("T", "B", "")).toBe(sha256Hex("T\nB"));
	expect(knowledgeContentDigest("T", "B", "S")).toBe(sha256Hex("S\nT\nB"));
});

test("an atom without canonical fields keeps the defaults and the N1 digest", async () => {
	const store = setup();
	await store.write((db) => upsertKnowledgeItem(db, item()));
	const row = store.read((db) => getKnowledgeById(db, "k1"))!;
	expect(row).toMatchObject({
		situation: "",
		rationale: "",
		exceptions: [],
		examples: [],
		retrieval: "searchable",
		contentDigest: knowledgeContentDigest(item().title, item().body),
	});
});

test("a canonical stores its fields and a digest that includes the situation", async () => {
	const store = setup();
	const canonical = item({
		id: "c1",
		layer: "canonical",
		situation: "本番DBのスキーマを変える直前",
		rationale: "戻せない変更だから",
		exceptions: ["開発用DB"],
		examples: [
			{ situation: "s", action: "a", outcome: "o", episodeIds: ["e1"] },
		],
	});
	expect(await store.write((db) => upsertKnowledgeItem(db, canonical))).toBe(
		"inserted",
	);
	const row = store.read((db) => getKnowledgeById(db, "c1"))!;
	expect(row.situation).toBe("本番DBのスキーマを変える直前");
	expect(row.rationale).toBe("戻せない変更だから");
	expect(row.exceptions).toEqual(["開発用DB"]);
	expect(row.examples[0]!.episodeIds).toEqual(["e1"]);
	expect(row.contentDigest).toBe(
		knowledgeContentDigest(
			canonical.title,
			canonical.body,
			canonical.situation,
		),
	);
	expect(await store.write((db) => upsertKnowledgeItem(db, canonical))).toBe(
		"unchanged",
	);
	expect(
		await store.write((db) =>
			upsertKnowledgeItem(db, { ...canonical, situation: "別の状況" }),
		),
	).toBe("updated");
});

test("canonical fields are checked", async () => {
	const store = setup();
	const bad = (over: Partial<KnowledgeInput>) =>
		expect(
			store.write((db) => upsertKnowledgeItem(db, item(over))),
		).rejects.toThrow("invalid_knowledge_input");
	await bad({ layer: "canonical" }); // a canonical always states its situation
	await bad({ layer: "canonical", situation: "" }); // a stated situation is a real one
	await bad({ layer: "canonical", situation: "  " });
	await bad({ layer: "canonical", situation: "x".repeat(601) });
	await bad({ situation: "s", rationale: "r".repeat(801) });
	await bad({ exceptions: Array.from({ length: 9 }, () => "e") });
	await bad({ exceptions: ["e".repeat(201)] });
	await bad({
		examples: Array.from({ length: 3 }, () => ({
			situation: "s",
			action: "a",
			outcome: "o",
			episodeIds: [],
		})),
	});
});

test("an update that leaves a canonical field out keeps the stored value", async () => {
	const store = setup();
	const full = {
		layer: "canonical" as const,
		situation: "本番DBへ書き込む前",
		rationale: "戻せないため",
		exceptions: ["読み取りだけのとき"],
	};
	await store.write((db) => upsertKnowledgeItem(db, item(full)));
	await store.write((db) =>
		upsertKnowledgeItem(
			db,
			item({ layer: "canonical", importance: 0.9, updatedAt: T2 }),
		),
	);
	const row = store.read((db) => getKnowledgeById(db, "k1"))!;
	expect(row.situation).toBe(full.situation);
	expect(row.rationale).toBe(full.rationale);
	expect(row.exceptions).toEqual(full.exceptions);
	expect(row.importance).toBe(0.9);
	expect(row.contentDigest).toBe(
		knowledgeContentDigest(item().title, item().body, full.situation),
	);
});

test("upsert never writes retrieval: an existing disposition survives a re-import", async () => {
	const store = setup();
	await store.write((db) => upsertKnowledgeItem(db, item()));
	await store.write((db) =>
		setKnowledgeDisposition(db, "k1", {
			status: "superseded",
			retrieval: "evidence_only",
			updatedAt: T2,
		}),
	);
	await store.write((db) =>
		upsertKnowledgeItem(db, item({ body: "本文が変わった", updatedAt: T2 })),
	);
	const row = store.read((db) => getKnowledgeById(db, "k1"))!;
	expect(row.retrieval).toBe("evidence_only");
	expect(row.body).toBe("本文が変わった");
});

test("setKnowledgeDisposition moves the revision only when something changed", async () => {
	const store = setup();
	await store.write((db) => upsertKnowledgeItem(db, item()));
	const set = (d: Parameters<typeof setKnowledgeDisposition>[2], id = "k1") =>
		store.write((db) => setKnowledgeDisposition(db, id, d));
	expect(await set({ updatedAt: T2 })).toBe(false);
	expect(await set({ retrieval: "searchable", updatedAt: T2 })).toBe(false);
	expect(store.read((db) => getKnowledgeById(db, "k1"))!.revision).toBe(1);
	expect(await set({ retrieval: "evidence_only", updatedAt: T2 })).toBe(true);
	let row = store.read((db) => getKnowledgeById(db, "k1"))!;
	expect(row).toMatchObject({
		retrieval: "evidence_only",
		status: "active",
		revision: 2,
		updatedAt: T2,
	});
	expect(
		await set({
			status: "superseded",
			retrieval: "evidence_only",
			updatedAt: T2,
		}),
	).toBe(true);
	row = store.read((db) => getKnowledgeById(db, "k1"))!;
	expect(row).toMatchObject({ status: "superseded", revision: 3 });
	expect(
		await set({
			status: "superseded",
			retrieval: "evidence_only",
			updatedAt: T2,
		}),
	).toBe(false);
	expect(await set({ status: "retracted", updatedAt: T2 }, "missing")).toBe(
		false,
	);
});

test("listSupersededBy reads the canonicals that derive from the atom, active first", async () => {
	const store = setup();
	await store.write((db) => {
		upsertKnowledgeItem(db, item({ id: "atom" }));
		upsertKnowledgeItem(
			db,
			item({
				id: "c-old",
				layer: "canonical",
				situation: "s",
				status: "superseded",
				title: "old",
			}),
		);
		upsertKnowledgeItem(
			db,
			item({ id: "c-new", layer: "canonical", situation: "s", title: "new" }),
		);
		upsertKnowledgeItem(
			db,
			item({
				id: "c-gone",
				layer: "canonical",
				situation: "s",
				status: "retracted",
				title: "gone",
			}),
		);
		upsertKnowledgeItem(db, item({ id: "other-atom", title: "x" }));
		for (const id of ["c-old", "c-new", "c-gone", "other-atom"])
			replaceKnowledgeEvidence(
				db,
				id,
				"pipeline",
				[
					{
						targetKind: "atom",
						targetId: "atom",
						externalRef: null,
						role: "derived_from",
						quote: null,
						confidence: null,
					},
				],
				T1,
			);
	});
	expect(store.read((db) => listSupersededBy(db, "atom"))).toEqual([
		"c-new",
		"c-old",
	]);
	expect(store.read((db) => listSupersededBy(db, "c-new"))).toEqual([]);
});
