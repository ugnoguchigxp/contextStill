import { expect, test } from "bun:test";
import {
	cosine,
	dot,
	l2norm,
	packVector,
	unpackVector,
	vectorSpaceKey,
} from "../../../infrastructure/vector";
import { LARM_EMBEDDING_SPACE } from "../../larm";

test("pack and unpack are Float32 little-endian and round-trip", () => {
	const values = [0, 1, -1, 0.5, 3.4028234663852886e38, 1e-30];
	const blob = packVector(values);
	expect(blob.byteLength).toBe(4 * values.length);
	expect([...unpackVector(blob)]).toEqual([...new Float32Array(values)]);
	// Little endian: 1.0f is 00 00 80 3f.
	expect([...packVector([1])]).toEqual([0x00, 0x00, 0x80, 0x3f]);
	// unpack reads from any offset of a larger buffer.
	const padded = new Uint8Array(blob.byteLength + 3);
	padded.set(blob, 3);
	expect([...unpackVector(padded.subarray(3))]).toEqual([
		...new Float32Array(values),
	]);
	expect(unpackVector(new Uint8Array(0)).length).toBe(0);
});

test("dot, norm and cosine", () => {
	expect(dot([1, 2, 3], [4, 5, 6])).toBe(32);
	expect(l2norm([3, 4])).toBe(5);
	expect(cosine([1, 0], [0, 1])).toBe(0);
	expect(cosine([2, 0], [5, 0])).toBeCloseTo(1, 12);
	expect(cosine([1, 0], [-3, 0])).toBeCloseTo(-1, 12);
	expect(cosine([0, 0], [1, 1])).toBe(0);
});

test("the key of the LARM e5 space is pinned", () => {
	const key = vectorSpaceKey({
		modelId: LARM_EMBEDDING_SPACE.model.id,
		revision: LARM_EMBEDDING_SPACE.model.revision,
		artifactDigest: LARM_EMBEDDING_SPACE.model.artifactDigest,
		dimension: LARM_EMBEDDING_SPACE.dimension,
	});
	expect(key).toMatch(/^[0-9a-f]{32}$/);
	expect(key).toBe("018ded9ab8b29f6ef2eb811c20e79004");
	// Every field takes part.
	const base = {
		modelId: "m",
		revision: "r",
		artifactDigest: "a",
		dimension: 384,
	};
	for (const change of [
		{ modelId: "n" },
		{ revision: "s" },
		{ artifactDigest: "b" },
		{ dimension: 385 },
	])
		expect(vectorSpaceKey({ ...base, ...change })).not.toBe(
			vectorSpaceKey(base),
		);
});
