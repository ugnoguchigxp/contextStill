import { sha256Hex } from "./digest";

/** The vector space a stored embedding belongs to (the shape every domain that stores vectors shares). */
export type VectorSpaceShape = {
	modelId: string;
	revision: string;
	artifactDigest: string;
	dimension: number;
};

/** Stable key of a vector space; vectors of different spaces are never compared. */
export function vectorSpaceKey(space: VectorSpaceShape): string {
	return sha256Hex(
		JSON.stringify([
			space.modelId,
			space.revision,
			space.artifactDigest,
			space.dimension,
		]),
	).slice(0, 32);
}
/** Float32 values, in the platform's (little endian) byte order, as a blob. */
export function packVector(values: ArrayLike<number>): Uint8Array {
	return new Uint8Array(Float32Array.from(values).buffer);
}
export function unpackVector(blob: Uint8Array): Float32Array {
	if (blob.byteLength % 4 !== 0) throw new Error("vector_blob_misaligned");
	const copy = new Uint8Array(blob);
	return new Float32Array(copy.buffer, 0, copy.byteLength / 4);
}
export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
	let sum = 0;
	for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
	return sum;
}
export function l2norm(v: ArrayLike<number>): number {
	return Math.sqrt(dot(v, v));
}
/** Cosine similarity; 0 when either vector has no length. */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
	const na = l2norm(a);
	const nb = l2norm(b);
	return na === 0 || nb === 0 ? 0 : dot(a, b) / (na * nb);
}
