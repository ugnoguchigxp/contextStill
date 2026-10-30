import { randomBytes } from "node:crypto";
import {
	chmodSync,
	linkSync,
	mkdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

/** The filesystem calls of token creation, replaceable in tests to interleave concurrent starters. */
export type TokenFs = Pick<
	typeof import("node:fs"),
	"linkSync" | "readFileSync" | "statSync" | "unlinkSync" | "writeFileSync"
>;
const realFs: TokenFs = {
	linkSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
};

type AuthEnvironment = {
	[key: string]: string | undefined;
	CONTEXT_STILL_API_TOKEN?: string;
	CONTEXT_STILL_MCP_TOKEN?: string;
	CONTEXT_STILL_DB?: string;
	CONTEXT_STILL_KEY_DIR?: string;
	LARM_API_TOKEN?: string;
	LARM_CONTROL_TOKEN?: string;
};

type TokenKind = "api" | "mcp";
const variableOf = (kind: TokenKind) =>
	kind === "api" ? "CONTEXT_STILL_API_TOKEN" : "CONTEXT_STILL_MCP_TOKEN";

/** Server-side only: never import into the browser bundle. */
export function resolveLarmToken(
	env: AuthEnvironment | typeof process.env,
): string | undefined {
	return (
		env.LARM_API_TOKEN?.trim() || env.LARM_CONTROL_TOKEN?.trim() || undefined
	);
}

function readTokenFile(path: string, fs: TokenFs = realFs): string {
	const token = fs.readFileSync(path, "utf8").trim();
	if (!/^[0-9a-f]{64}$/.test(token)) throw new Error("token_file_invalid");
	return token;
}

function tokenPath(
	kind: TokenKind,
	env: AuthEnvironment | typeof process.env,
	defaultDbPath: string,
): { keys: string; path: string } {
	const dbPath = env.CONTEXT_STILL_DB?.trim() || defaultDbPath;
	// Same rule as Settings (createSettings): CONTEXT_STILL_KEY_DIR, else <dbDir>/keys.
	const keys =
		env.CONTEXT_STILL_KEY_DIR?.trim() || join(dirname(resolve(dbPath)), "keys");
	return { keys, path: join(keys, `${kind}.token`) };
}

function explicitToken(
	kind: TokenKind,
	env: AuthEnvironment | typeof process.env,
): string | undefined {
	const name = variableOf(kind);
	const explicit = env[name]?.trim();
	if (!explicit) return undefined;
	if (explicit.length < 24)
		throw new Error(`${name} must be at least 24 characters`);
	return explicit;
}

function readToken(
	kind: TokenKind,
	env: AuthEnvironment | typeof process.env,
	defaultDbPath: string,
): string {
	const explicit = explicitToken(kind, env);
	if (explicit) return explicit;
	const { path } = tokenPath(kind, env, defaultDbPath);
	try {
		return readTokenFile(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			throw new Error(`${kind}_token_not_found:${path}`);
		throw error;
	}
}

/**
 * Client-side resolution (maintenance commands, scripts): never creates or alters a
 * credential. `defaultDbPath` anchors the default to the project, not the caller's cwd.
 */
export function readApiToken(
	env: AuthEnvironment | typeof process.env,
	defaultDbPath = "./data/context-still.sqlite3",
): string {
	return readToken("api", env, defaultDbPath);
}

export function readMcpToken(
	env: AuthEnvironment | typeof process.env,
	defaultDbPath = "./data/context-still.sqlite3",
): string {
	return readToken("mcp", env, defaultDbPath);
}

function tighten(path: string, mode: number, loose: number): void {
	try {
		if (statSync(path).mode & loose) chmodSync(path, mode);
	} catch (error) {
		// Not ours to tighten (EPERM): usable if readable.
		if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
	}
}

function ensurePrivateDir(dir: string): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	tighten(dir, 0o700, 0o077);
}

const PARTIAL_TOKEN_AGE_MS = 10_000;

const missing = (message: string) =>
	Object.assign(new Error(message), { code: "ENOENT" });
const isMissing = (error: unknown) =>
	(error as NodeJS.ErrnoException).code === "ENOENT";

/**
 * Server-side read: tightens permissions and recovers an abandoned partial file.
 * A recovery (or a file that vanished or was replaced meanwhile) is reported as
 * ENOENT so the caller creates or re-reads the token.
 */
function readOwnedTokenFile(path: string, fs: TokenFs): string {
	tighten(path, 0o600, 0o077);
	try {
		return readTokenFile(path, fs);
	} catch (error) {
		if ((error as Error).message !== "token_file_invalid") throw error;
		const before = fs.statSync(path);
		const content = fs.readFileSync(path, "utf8").trim();
		// Replaced by a valid token since the first read: share it.
		if (/^[0-9a-f]{64}$/.test(content)) return content;
		const stale = Date.now() - before.mtimeMs >= PARTIAL_TOKEN_AGE_MS;
		if (!stale || !/^[0-9a-f]{0,63}$/.test(content)) throw error;
		// Another starter may have replaced the abandoned file with a valid token
		// since it was judged stale: delete only the very file that was inspected.
		const now = fs.statSync(path);
		if (
			now.ino !== before.ino ||
			now.dev !== before.dev ||
			now.mtimeMs !== before.mtimeMs ||
			now.size !== before.size
		)
			throw missing("token_file_replaced");
		fs.unlinkSync(path);
		throw missing("token_file_recovered");
	}
}

/** Create the token file, or share one a concurrent starter created; null means retry. */
function createTokenFile(path: string, fs: TokenFs): string | null {
	const token = randomBytes(32).toString("hex");
	// Fill a private temp file first, then link it into place: readers never
	// observe a partial file, and an existing target is never replaced.
	const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	fs.writeFileSync(temp, token, { mode: 0o600, flag: "wx" });
	const share = () => {
		try {
			return readOwnedTokenFile(path, fs);
		} catch (error) {
			if (isMissing(error)) return null;
			throw error;
		}
	};
	try {
		fs.linkSync(temp, path);
		return token;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		// A concurrent starter created it first: share its token.
		if (code === "EEXIST") return share();
		// Filesystems without hard links: fall back to an exclusive create.
		if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP")
			throw error;
		try {
			fs.writeFileSync(path, token, { mode: 0o600, flag: "wx" });
			return token;
		} catch (inner) {
			if ((inner as NodeJS.ErrnoException).code !== "EEXIST") throw inner;
			return share();
		}
	} finally {
		try {
			fs.unlinkSync(temp);
		} catch {
			// Best effort: the temp name is unique and holds no live credential path.
		}
	}
}

function ensureToken(
	kind: TokenKind,
	env: AuthEnvironment | typeof process.env,
	defaultDbPath: string,
	fs: TokenFs,
): string {
	const explicit = explicitToken(kind, env);
	if (explicit) return explicit;
	const { keys, path } = tokenPath(kind, env, defaultDbPath);
	// A concurrent starter can recreate or remove the file between steps: retry.
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			return readOwnedTokenFile(path, fs);
		} catch (error) {
			if (!isMissing(error)) throw error;
		}
		ensurePrivateDir(keys);
		const token = createTokenFile(path, fs);
		if (token) return token;
	}
	throw new Error(`${kind}_token_unavailable`);
}

/**
 * The local API credential is independent of the LARM credential and of the MCP credential:
 * an explicit CONTEXT_STILL_API_TOKEN, else a random token kept beside the database (0600).
 */
export function ensureApiToken(
	env: AuthEnvironment | typeof process.env,
	defaultDbPath = "./data/context-still.sqlite3",
	fs: TokenFs = realFs,
): string {
	return ensureToken("api", env, defaultDbPath, fs);
}

/** The MCP credential (the only one handed to Eumenes): same rules as the API token, own file. */
export function ensureMcpToken(
	env: AuthEnvironment | typeof process.env,
	defaultDbPath = "./data/context-still.sqlite3",
	fs: TokenFs = realFs,
): string {
	return ensureToken("mcp", env, defaultDbPath, fs);
}
