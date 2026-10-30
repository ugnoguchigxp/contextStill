import { afterEach, expect, test } from "bun:test";
import { tempStore } from "../../../infrastructure/sqlite/test-support";
import { packVector } from "../../../infrastructure/vector";
import { LARM_EMBEDDING_SPACE } from "../../larm";
import {
	ensureVectorSpace,
	getVector,
	migrations,
	recordVerificationRun,
	setVerification,
	topK,
	upsertVector,
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
const unit = (i: number) => {
	const v = new Float32Array(384);
	v[i] = 1;
	return v;
};
const base = (spaceKey: string) => ({
	ownerKind: "knowledge" as const,
	ownerId: "k1",
	spaceKey,
	contentDigest: "d1",
	vector: unit(0),
	origin: "legacy_import" as const,
	verification: "unverified" as const,
	now: T1,
});

test("ensureVectorSpace is idempotent and stores the descriptor", async () => {
	const store = setup();
	const key = await store.write((db) =>
		ensureVectorSpace(db, LARM_EMBEDDING_SPACE, T1),
	);
	expect(key).toBe("018ded9ab8b29f6ef2eb811c20e79004");
	expect(
		await store.write((db) => ensureVectorSpace(db, LARM_EMBEDDING_SPACE, T2)),
	).toBe(key);
	const row = store.read((db) =>
		db.query("SELECT * FROM vector_spaces").all(),
	) as any[];
	expect(row).toHaveLength(1);
	expect(row[0]).toMatchObject({
		space_key: key,
		model_id: "intfloat/multilingual-e5-small",
		dimension: 384,
		created_at: T1,
	});
	expect(JSON.parse(row[0].descriptor_json).contractVersion).toBe(
		"larm-embedding.v1",
	);
});

test("upsertVector: inserted, unchanged, updated; created_at stays", async () => {
	const store = setup();
	const key = await store.write((db) =>
		ensureVectorSpace(db, LARM_EMBEDDING_SPACE, T1),
	);
	expect(await store.write((db) => upsertVector(db, base(key)))).toBe(
		"inserted",
	);
	expect(
		await store.write((db) => upsertVector(db, { ...base(key), now: T2 })),
	).toBe("unchanged");
	expect(
		await store.write((db) =>
			upsertVector(db, {
				...base(key),
				now: T2,
				verification: "verified",
				origin: "larm",
				vector: unit(1),
			}),
		),
	).toBe("updated");
	const stored = store.read((db) => getVector(db, "knowledge", "k1", key))!;
	expect(stored.verification).toBe("verified");
	expect(stored.origin).toBe("larm");
	expect(stored.contentDigest).toBe("d1");
	expect([...stored.vector.subarray(0, 3)]).toEqual([0, 1, 0]);
	const raw = store.read((db) =>
		db.query("SELECT created_at, updated_at FROM vectors").get(),
	);
	expect(raw).toEqual({ created_at: T1, updated_at: T2 });
	expect(
		store.read((db) => getVector(db, "knowledge", "nope", key)),
	).toBeNull();
	expect(store.read((db) => getVector(db, "episode", "k1", key))).toBeNull();
});

test("the blob must be 4 x dimension bytes, finite, in a known space", async () => {
	const store = setup();
	const key = await store.write((db) =>
		ensureVectorSpace(db, LARM_EMBEDDING_SPACE, T1),
	);
	await expect(
		store.write((db) =>
			upsertVector(db, { ...base(key), vector: new Float32Array(383) }),
		),
	).rejects.toThrow("vector_dimension_mismatch");
	await expect(
		store.write((db) =>
			upsertVector(db, { ...base(key), vector: new Float32Array(385) }),
		),
	).rejects.toThrow("vector_dimension_mismatch");
	const bad = unit(0);
	bad[5] = Number.NaN;
	await expect(
		store.write((db) => upsertVector(db, { ...base(key), vector: bad })),
	).rejects.toThrow("vector_not_finite");
	await expect(
		store.write((db) => upsertVector(db, base("0".repeat(32)))),
	).rejects.toThrow("vector_space_unknown");
	expect(
		store.read((db) => db.query("SELECT count(*) AS n FROM vectors").get()),
	).toEqual({ n: 0 });
	// SQL alone does not catch a short blob; the repository is the guard.
	await store.write((db) =>
		db
			.query(
				"INSERT INTO vectors (owner_kind, owner_id, space_key, content_digest, vector, origin, verification, created_at, updated_at) VALUES ('knowledge','x',?, 'd', ?, 'larm','verified','t','t')",
			)
			.run(key, packVector([1, 2, 3])),
	);
});

test("setVerification moves only the matching vectors and counts them", async () => {
	const store = setup();
	const key = await store.write((db) =>
		ensureVectorSpace(db, LARM_EMBEDDING_SPACE, T1),
	);
	await store.write((db) => {
		upsertVector(db, { ...base(key), ownerId: "a" });
		upsertVector(db, { ...base(key), ownerId: "b" });
		upsertVector(db, {
			...base(key),
			ownerId: "c",
			origin: "larm",
			verification: "unverified",
		});
		upsertVector(db, { ...base(key), ownerId: "d", verification: "stale" });
		upsertVector(db, { ...base(key), ownerKind: "episode", ownerId: "e" });
	});
	const moved = await store.write((db) =>
		setVerification(db, {
			spaceKey: key,
			ownerKind: "knowledge",
			origin: "legacy_import",
			from: ["unverified"],
			to: "verified",
			now: T2,
		}),
	);
	expect(moved).toBe(2);
	const state = (id: string, kind: "knowledge" | "episode" = "knowledge") =>
		store.read((db) => getVector(db, kind, id, key))!.verification;
	expect([
		state("a"),
		state("b"),
		state("c"),
		state("d"),
		state("e", "episode"),
	]).toEqual(["verified", "verified", "unverified", "stale", "unverified"]);
	expect(
		await store.write((db) =>
			setVerification(db, {
				spaceKey: key,
				ownerKind: "knowledge",
				origin: "legacy_import",
				from: [],
				to: "mismatch",
				now: T2,
			}),
		),
	).toBe(0);
});

test("setVerification with ownerIds moves only those owners, in chunks", async () => {
	const store = setup();
	const key = await store.write((db) =>
		ensureVectorSpace(db, LARM_EMBEDDING_SPACE, T1),
	);
	const ids = Array.from({ length: 1203 }, (_, i) => `k${i}`);
	await store.write((db) => {
		for (const id of ids) upsertVector(db, { ...base(key), ownerId: id });
		upsertVector(db, { ...base(key), ownerId: "outside" });
	});
	const input = {
		spaceKey: key,
		ownerKind: "knowledge" as const,
		origin: "legacy_import" as const,
		from: ["unverified" as const],
		to: "mismatch" as const,
		now: T2,
	};
	expect(
		await store.write((db) => setVerification(db, { ...input, ownerIds: [] })),
	).toBe(0);
	expect(
		await store.write((db) =>
			setVerification(db, { ...input, ownerIds: [...ids, "missing"] }),
		),
	).toBe(1203);
	const state = (id: string) =>
		store.read((db) => getVector(db, "knowledge", id, key))!.verification;
	expect([state("k0"), state("k1202"), state("outside")]).toEqual([
		"mismatch",
		"mismatch",
		"unverified",
	]);
});

test("recordVerificationRun stores the run", async () => {
	const store = setup();
	const key = await store.write((db) =>
		ensureVectorSpace(db, LARM_EMBEDDING_SPACE, T1),
	);
	await store.write((db) =>
		recordVerificationRun(db, {
			id: "run1",
			spaceKey: key,
			ownerKind: "knowledge",
			origin: "legacy_import",
			sampleSize: 32,
			minCosine: 0.9971,
			meanCosine: 0.9995,
			thresholdMin: 0.995,
			thresholdMean: 0.999,
			passed: true,
			detail: { note: "x" },
			now: T1,
		}),
	);
	expect(
		store.read((db) => db.query("SELECT * FROM vector_verifications").get()),
	).toEqual({
		id: "run1",
		space_key: key,
		owner_kind: "knowledge",
		origin: "legacy_import",
		sample_size: 32,
		min_cosine: 0.9971,
		mean_cosine: 0.9995,
		threshold_min: 0.995,
		threshold_mean: 0.999,
		passed: 1,
		detail_json: '{"note":"x"}',
		created_at: T1,
	});
});

test("topK ranks by dot product, ties by owner id, and skips wrong-length blobs", () => {
	const query = new Float32Array([1, 0, 0]);
	const rows = [
		{ ownerId: "b", vector: packVector([0.5, 0.5, 0]) },
		{ ownerId: "a", vector: packVector([0.5, 0.5, 0]) },
		{ ownerId: "z", vector: packVector([1, 0, 0]) },
		{ ownerId: "n", vector: packVector([-1, 0, 0]) },
		{ ownerId: "short", vector: packVector([1, 0]) },
	];
	expect(topK(query, rows, 10)).toEqual([
		{ ownerId: "z", score: 1 },
		{ ownerId: "a", score: 0.5 },
		{ ownerId: "b", score: 0.5 },
		{ ownerId: "n", score: -1 },
	]);
	expect(topK(query, rows, 2).map((r) => r.ownerId)).toEqual(["z", "a"]);
	expect(topK(query, rows, 0)).toEqual([]);
	expect(topK(query, [], 5)).toEqual([]);
	// Any iterable works.
	expect(topK(query, new Set(rows).values(), 1)[0]?.ownerId).toBe("z");
});
