import {
	closeSync,
	fsyncSync,
	linkSync,
	openSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

function syncDirectory(path: string) {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		fsyncSync(fd);
	} catch {
		// Directory fsync is unsupported on some filesystems; the file itself is already synced.
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function writeSynced(path: string, data: string | Uint8Array, mode: number) {
	const fd = openSync(path, "wx", mode);
	try {
		writeFileSync(fd, data);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

/**
 * Creates `path` with the full content or not at all. The content is written and synced to a
 * private temp file first and then hard-linked into place, so a crash never leaves an empty or
 * short file at `path` and an existing file is never replaced. Returns false when `path`
 * already exists (a concurrent creator won); the caller reads what it wrote.
 */
export function createFileExclusive(
	path: string,
	data: string | Uint8Array,
	mode = 0o600,
): boolean {
	const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	writeSynced(temp, data, mode);
	try {
		linkSync(temp, path);
		syncDirectory(dirname(path));
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EEXIST") return false;
		// Filesystems without hard links: fall back to an exclusive create.
		if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP")
			throw error;
		try {
			writeSynced(path, data, mode);
			return true;
		} catch (inner) {
			if ((inner as NodeJS.ErrnoException).code === "EEXIST") return false;
			throw inner;
		}
	} finally {
		try {
			unlinkSync(temp);
		} catch {
			// Best effort: the temp name is unique and the content is already in place or unused.
		}
	}
}
