import type { Database } from "bun:sqlite";
import { canonicalJson } from "../../../infrastructure/digest";
import type { UpsertResult } from "../../../infrastructure/scope";
import { upsertRow } from "../../../infrastructure/sqlite/upsert";
import {
	dot,
	packVector,
	unpackVector,
	vectorSpaceKey,
} from "../../../infrastructure/vector";
import type {
	SetVerificationInput,
	StoredVector,
	UpsertVectorInput,
	VectorOrigin,
	VectorOwnerKind,
	VectorSpaceDescriptor,
	VectorVerification,
	VerificationRun,
} from "../contracts";

export { migrations } from "./migrations";

/** Registers the space (idempotent) and returns its `space_key`. */
export function ensureVectorSpace(
	db: Database,
	descriptor: VectorSpaceDescriptor,
	now: string,
): string {
	const spaceKey = vectorSpaceKey({
		modelId: descriptor.model.id,
		revision: descriptor.model.revision,
		artifactDigest: descriptor.model.artifactDigest,
		dimension: descriptor.dimension,
	});
	db.query(
		`INSERT INTO vector_spaces
		   (space_key, model_id, revision, artifact_digest, dimension, descriptor_json, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(space_key) DO NOTHING`,
	).run(
		spaceKey,
		descriptor.model.id,
		descriptor.model.revision,
		descriptor.model.artifactDigest,
		descriptor.dimension,
		canonicalJson(descriptor),
		now,
	);
	return spaceKey;
}

/** The blob is 4 bytes per dimension of its space; SQL cannot check that. */
function checkedBlob(
	db: Database,
	spaceKey: string,
	vector: Float32Array,
): Uint8Array {
	const space = db
		.query("SELECT dimension FROM vector_spaces WHERE space_key = ?")
		.get(spaceKey) as { dimension: number } | null;
	if (!space) throw new Error("vector_space_unknown");
	if (vector.length !== space.dimension)
		throw new Error("vector_dimension_mismatch");
	for (const value of vector)
		if (!Number.isFinite(value)) throw new Error("vector_not_finite");
	const blob = packVector(vector);
	if (blob.byteLength !== 4 * space.dimension)
		throw new Error("vector_dimension_mismatch");
	return blob;
}

export function upsertVector(
	db: Database,
	input: UpsertVectorInput,
): UpsertResult {
	const blob = checkedBlob(db, input.spaceKey, input.vector);
	return upsertRow(db, {
		table: "vectors",
		key: {
			owner_kind: input.ownerKind,
			owner_id: input.ownerId,
			space_key: input.spaceKey,
		},
		values: {
			content_digest: input.contentDigest,
			vector: blob,
			origin: input.origin,
			verification: input.verification,
		},
		insertOnly: { created_at: input.now },
		touch: { updated_at: input.now },
	});
}

export function getVector(
	db: Database,
	ownerKind: VectorOwnerKind,
	ownerId: string,
	spaceKey: string,
): StoredVector | null {
	const row = db
		.query(
			`SELECT content_digest, vector, origin, verification FROM vectors
			 WHERE owner_kind = ? AND owner_id = ? AND space_key = ?`,
		)
		.get(ownerKind, ownerId, spaceKey) as {
		content_digest: string;
		vector: Uint8Array;
		origin: VectorOrigin;
		verification: VectorVerification;
	} | null;
	return row
		? {
				contentDigest: row.content_digest,
				vector: unpackVector(row.vector),
				origin: row.origin,
				verification: row.verification,
			}
		: null;
}

/**
 * `SetVerificationInput` plus an optional owner restriction. With `ownerIds` only the vectors of
 * those owners move (an empty list moves nothing); without it the whole space/kind/origin does.
 */
export type SetVerificationScopedInput = SetVerificationInput & {
	ownerIds?: readonly string[];
};

/** Owner ids per UPDATE: well under SQLite's bound-variable limit with the fixed parameters. */
const OWNER_ID_CHUNK = 500;

/**
 * Moves vectors of one space, owner kind and origin between verification states, optionally
 * only those of `ownerIds`. Runs inside the caller's transaction (one `store.write`).
 */
export function setVerification(
	db: Database,
	input: SetVerificationScopedInput,
): number {
	if (input.from.length === 0) return 0;
	const fromMarks = input.from.map(() => "?").join(", ");
	const run = (ownerIds: readonly string[] | null): number =>
		db
			.query(
				`UPDATE vectors SET verification = ?, updated_at = ?
				 WHERE space_key = ? AND owner_kind = ? AND origin = ?
				   AND verification IN (${fromMarks})${
							ownerIds
								? ` AND owner_id IN (${ownerIds.map(() => "?").join(", ")})`
								: ""
						}`,
			)
			.run(
				input.to,
				input.now,
				input.spaceKey,
				input.ownerKind,
				input.origin,
				...input.from,
				...(ownerIds ?? []),
			).changes;
	if (input.ownerIds === undefined) return run(null);
	let changes = 0;
	for (let i = 0; i < input.ownerIds.length; i += OWNER_ID_CHUNK)
		changes += run(input.ownerIds.slice(i, i + OWNER_ID_CHUNK));
	return changes;
}

export function recordVerificationRun(
	db: Database,
	run: VerificationRun,
): void {
	db.query(
		`INSERT INTO vector_verifications
		   (id, space_key, owner_kind, origin, sample_size, min_cosine, mean_cosine,
		    threshold_min, threshold_mean, passed, detail_json, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		run.id,
		run.spaceKey,
		run.ownerKind,
		run.origin,
		run.sampleSize,
		run.minCosine,
		run.meanCosine,
		run.thresholdMin,
		run.thresholdMean,
		run.passed ? 1 : 0,
		canonicalJson(run.detail),
		run.now,
	);
}

/**
 * Exact scan: the `k` best by dot product (vectors are L2-normalised), ties by owner id
 * ascending. Rows whose blob does not match the query's length are skipped.
 */
export function topK(
	query: Float32Array,
	rows: Iterable<{ ownerId: string; vector: Uint8Array }>,
	k: number,
): { ownerId: string; score: number }[] {
	if (k <= 0) return [];
	const scored: { ownerId: string; score: number }[] = [];
	for (const row of rows) {
		if (row.vector.byteLength !== query.length * 4) continue;
		scored.push({
			ownerId: row.ownerId,
			score: dot(query, unpackVector(row.vector)),
		});
	}
	scored.sort(
		(a, b) =>
			b.score - a.score ||
			(a.ownerId < b.ownerId ? -1 : a.ownerId > b.ownerId ? 1 : 0),
	);
	return scored.slice(0, k);
}
