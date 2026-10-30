import { expect, test } from "bun:test";
import { packVector, unpackVector } from "./vector";

test("unpackVector round-trips and refuses a blob that is not whole float32 values", () => {
	expect([...unpackVector(packVector([1, 2.5, -3]))]).toEqual([1, 2.5, -3]);
	expect(unpackVector(new Uint8Array(0)).length).toBe(0);
	for (const size of [1, 2, 3, 5, 13])
		expect(() => unpackVector(new Uint8Array(size))).toThrow(
			"vector_blob_misaligned",
		);
});
