import { dlopen, FFIType, type Pointer, read } from "bun:ffi";

export const LOCK_EX_NB = 2 | 4;
export const LOCK_UN = 8;

export function flockLibraryPath(platform = process.platform): string | null {
	if (platform === "darwin") return "/usr/lib/libSystem.B.dylib";
	if (platform === "linux") return "libc.so.6";
	return null;
}

/** EWOULDBLOCK and EAGAIN: the lock is held by someone else (one value per platform). */
export function wouldBlockErrno(platform = process.platform): number {
	return platform === "darwin" ? 35 : 11;
}

interface Libc {
	flock(fd: number, operation: number): number;
	errnoLocation(): Pointer | null;
}
let lib: Libc | undefined;

// Loaded on first use so importing this module never dlopens (or fails) on an unsupported host.
function load(): Libc {
	if (lib) return lib;
	const path = flockLibraryPath();
	if (!path) throw new Error("flock_unsupported_platform");
	const darwin = process.platform === "darwin";
	const handle = darwin
		? dlopen(path, {
				flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
				__error: { args: [], returns: FFIType.ptr },
			})
		: dlopen(path, {
				flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
				__errno_location: { args: [], returns: FFIType.ptr },
			});
	const symbols = handle.symbols as unknown as {
		flock: Libc["flock"];
		__error?: Libc["errnoLocation"];
		__errno_location?: Libc["errnoLocation"];
	};
	lib = {
		flock: symbols.flock,
		errnoLocation: (symbols.__error ?? symbols.__errno_location)!,
	};
	return lib;
}

export function flock(fd: number, operation: number): number {
	return load().flock(fd, operation);
}

export type FlockResult =
	| { ok: true }
	| { ok: false; errno: number; wouldBlock: boolean };

/**
 * `flock` with the failure reason: `wouldBlock` is true only when another holder has the lock
 * (EWOULDBLOCK/EAGAIN); every other errno (ENOTSUP, ENOLCK, ...) is a different failure.
 */
export function tryFlock(fd: number, operation: number): FlockResult {
	const libc = load();
	if (libc.flock(fd, operation) === 0) return { ok: true };
	// errno is read right after the call, before other work can overwrite it.
	const location = libc.errnoLocation();
	const errno = location === null ? -1 : read.i32(location);
	return { ok: false, errno, wouldBlock: errno === wouldBlockErrno() };
}
