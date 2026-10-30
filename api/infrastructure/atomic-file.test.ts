import { expect, test } from "bun:test";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileExclusive } from "./atomic-file";

test("creates the full content once, owner-only, and leaves no temp file", () => {
	const dir = mkdtempSync(join(tmpdir(), "context-still-atomic-"));
	try {
		const path = join(dir, "secret.key");
		expect(createFileExclusive(path, Buffer.from("a".repeat(32)))).toBe(true);
		expect(readFileSync(path, "utf8")).toBe("a".repeat(32));
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(readdirSync(dir)).toEqual(["secret.key"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("never replaces an existing file and reports the lost race", () => {
	const dir = mkdtempSync(join(tmpdir(), "context-still-atomic-"));
	try {
		const path = join(dir, "secret.key");
		expect(createFileExclusive(path, "first")).toBe(true);
		expect(createFileExclusive(path, "second")).toBe(false);
		expect(readFileSync(path, "utf8")).toBe("first");
		expect(readdirSync(dir)).toEqual(["secret.key"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
