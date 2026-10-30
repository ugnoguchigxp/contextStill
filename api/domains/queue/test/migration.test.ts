import { expect, test } from "bun:test";
import { sha256Hex } from "../../../infrastructure/digest";
import { migration, migrations } from "../repository";

test("queue/0001-init is the Eumenes SQL, character for character", () => {
	expect(sha256Hex(migration)).toBe(
		"f6f01426e355bc6693c2c653cb0dbc4a1ba40330eb542ea503d9e185fe9ff7dd",
	);
	expect(migrations.map((m) => m.id)).toEqual(["queue/0001-init"]);
	expect(migrations[0]?.sql).toBe(migration);
});
