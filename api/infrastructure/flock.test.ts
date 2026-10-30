import { expect, test } from "bun:test";
import { closeSync, constants, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	flock,
	flockLibraryPath,
	LOCK_EX_NB,
	LOCK_UN,
	tryFlock,
	wouldBlockErrno,
} from "./flock";

test("the libc path is chosen per platform and unsupported hosts have none", () => {
	expect(flockLibraryPath("darwin")).toBe("/usr/lib/libSystem.B.dylib");
	expect(flockLibraryPath("linux")).toBe("libc.so.6");
	expect(flockLibraryPath("win32")).toBeNull();
});

test("an exclusive lock on one descriptor blocks a second descriptor until released", () => {
	const path = join(
		tmpdir(),
		`context-still-flock-${process.pid}-${Date.now()}`,
	);
	const a = openSync(path, constants.O_CREAT | constants.O_RDWR, 0o600);
	const b = openSync(path, constants.O_RDWR);
	try {
		expect(flock(a, LOCK_EX_NB)).toBe(0);
		expect(flock(b, LOCK_EX_NB)).not.toBe(0);
		expect(flock(a, LOCK_UN)).toBe(0);
		expect(flock(b, LOCK_EX_NB)).toBe(0);
		expect(flock(b, LOCK_UN)).toBe(0);
	} finally {
		closeSync(a);
		closeSync(b);
		rmSync(path, { force: true });
	}
});

test("tryFlock tells a held lock (wouldBlock) from other failures", () => {
	const path = join(
		tmpdir(),
		`context-still-tryflock-${process.pid}-${Date.now()}`,
	);
	const a = openSync(path, constants.O_CREAT | constants.O_RDWR, 0o600);
	const b = openSync(path, constants.O_RDWR);
	try {
		expect(tryFlock(a, LOCK_EX_NB)).toEqual({ ok: true });
		const held = tryFlock(b, LOCK_EX_NB);
		expect(held).toMatchObject({ ok: false, wouldBlock: true });
		// An invalid operation is EINVAL, not a held lock.
		const invalid = tryFlock(a, 0);
		expect(invalid).toMatchObject({ ok: false, wouldBlock: false });
		expect(wouldBlockErrno("darwin")).toBe(35);
		expect(wouldBlockErrno("linux")).toBe(11);
	} finally {
		flock(a, LOCK_UN);
		closeSync(a);
		closeSync(b);
		rmSync(path, { force: true });
	}
});
