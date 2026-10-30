export type VectorOwnerKind = "knowledge" | "episode";
export type VectorOrigin = "legacy_import" | "larm";
export type VectorVerification =
	| "unverified"
	| "verified"
	| "mismatch"
	| "stale";

/**
 * What a vector space needs to know about an embedding space. `LarmEmbeddingSpace` (larm
 * domain) satisfies it structurally, so vectors does not depend on larm (same tier).
 */
export interface VectorSpaceDescriptor {
	readonly model: {
		readonly id: string;
		readonly revision: string;
		readonly artifactDigest: string;
	};
	readonly dimension: number;
}

export interface UpsertVectorInput {
	ownerKind: VectorOwnerKind;
	ownerId: string;
	spaceKey: string;
	contentDigest: string;
	vector: Float32Array;
	origin: VectorOrigin;
	verification: VectorVerification;
	now: string;
}

export interface StoredVector {
	contentDigest: string;
	vector: Float32Array;
	origin: VectorOrigin;
	verification: VectorVerification;
}

export interface SetVerificationInput {
	spaceKey: string;
	ownerKind: VectorOwnerKind;
	origin: VectorOrigin;
	from: VectorVerification[];
	to: VectorVerification;
	now: string;
}

export interface VerificationRun {
	id: string;
	spaceKey: string;
	ownerKind: VectorOwnerKind;
	origin: VectorOrigin;
	sampleSize: number;
	minCosine: number | null;
	meanCosine: number | null;
	thresholdMin: number;
	thresholdMean: number;
	passed: boolean;
	detail: Record<string, unknown>;
	now: string;
}

export const vectorErrorStatus = {
	vector_space_unknown: 409,
	vector_dimension_mismatch: 422,
	vector_not_finite: 422,
} as const;
