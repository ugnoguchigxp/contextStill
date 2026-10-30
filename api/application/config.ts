import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { resolveLarmToken } from "../infrastructure/auth-config";

export const DEFAULT_PORT = 39181;
export const APP_VERSION = "2.0.0-alpha.0";

/** Ports of the v1 system; v2 never binds them. */
const LEGACY_PORTS: readonly number[] = [39171, 39172];
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export type ConfigErrorCode =
	| "db_path_invalid"
	| "path_reserved_by_legacy"
	| "host_not_loopback"
	| "port_invalid"
	| "port_reserved_by_legacy"
	| "secret_key_invalid"
	| "api_token_too_short"
	| "mcp_token_too_short"
	| "tokens_not_distinct";

export class ConfigError extends Error {
	constructor(public code: ConfigErrorCode) {
		super(code);
		this.name = "ConfigError";
	}
}

export interface RuntimeConfig {
	/** Absolute path of the SQLite file. */
	dbPath: string;
	/** Absolute directory of settings.key, api.token and mcp.token. */
	keyDir: string;
	/** CONTEXT_STILL_SECRET_KEY as given (base64, validated to be 32 bytes). */
	secretKey: string | undefined;
	apiToken: string | undefined;
	mcpToken: string | undefined;
	host: string;
	port: number;
	larmToken: string | undefined;
}

/** Locations of the v1 system and its backup: compared as strings, never looked up on disk. */
function reservedRoots(): string[] {
	const home = homedir();
	return [
		join(home, "Code", "contextStill-legacy"),
		join(home, "Library", "Application Support", "contextStill"),
		join(home, "Code", "contextStill-db-backup-20261029"),
	];
}

function isUnder(path: string, root: string): boolean {
	const a = path.toLowerCase();
	const b = root.toLowerCase();
	return a === b || a.startsWith(b.endsWith(sep) ? b : `${b}${sep}`);
}

function checkNotReserved(path: string): void {
	if (reservedRoots().some((root) => isUnder(path, root)))
		throw new ConfigError("path_reserved_by_legacy");
}

function absolute(value: string, repoRoot: string): string {
	const home = homedir();
	const expanded =
		value === "~"
			? home
			: value.startsWith("~/")
				? join(home, value.slice(2))
				: value;
	return isAbsolute(expanded) ? resolve(expanded) : resolve(repoRoot, expanded);
}

const trimmed = (value: string | undefined): string | undefined => {
	const text = value?.trim();
	return text ? text : undefined;
};

/**
 * The only reader of the environment. It looks at the variables of the plan's table and
 * nothing else; v1 variables are ignored whatever their value.
 */
export function resolveConfig(
	env: Record<string, string | undefined>,
	repoRoot: string,
): RuntimeConfig {
	const dbValue = trimmed(env.CONTEXT_STILL_DB);
	if (dbValue === ":memory:") throw new ConfigError("db_path_invalid");
	const dbPath = dbValue
		? absolute(dbValue, repoRoot)
		: join(resolve(repoRoot), "data", "context-still.sqlite3");
	checkNotReserved(dbPath);

	const keyValue = trimmed(env.CONTEXT_STILL_KEY_DIR);
	const keyDir = keyValue
		? absolute(keyValue, repoRoot)
		: join(dirname(dbPath), "keys");
	checkNotReserved(keyDir);

	const host = trimmed(env.CONTEXT_STILL_HOST) ?? "127.0.0.1";
	if (!LOOPBACK_HOSTS.has(host)) throw new ConfigError("host_not_loopback");

	const portText = trimmed(env.CONTEXT_STILL_PORT);
	const port = portText === undefined ? DEFAULT_PORT : Number(portText);
	if (
		portText !== undefined &&
		(!/^\d{1,5}$/.test(portText) || port < 1024 || port > 65535)
	)
		throw new ConfigError("port_invalid");
	if (LEGACY_PORTS.includes(port))
		throw new ConfigError("port_reserved_by_legacy");

	const secretKey = trimmed(env.CONTEXT_STILL_SECRET_KEY);
	if (secretKey !== undefined && Buffer.from(secretKey, "base64").length !== 32)
		throw new ConfigError("secret_key_invalid");

	const apiToken = trimmed(env.CONTEXT_STILL_API_TOKEN);
	if (apiToken !== undefined && apiToken.length < 24)
		throw new ConfigError("api_token_too_short");
	const mcpToken = trimmed(env.CONTEXT_STILL_MCP_TOKEN);
	if (mcpToken !== undefined && mcpToken.length < 24)
		throw new ConfigError("mcp_token_too_short");
	if (apiToken !== undefined && apiToken === mcpToken)
		throw new ConfigError("tokens_not_distinct");

	return {
		dbPath,
		keyDir,
		secretKey,
		apiToken,
		mcpToken,
		host,
		port,
		larmToken: resolveLarmToken(env),
	};
}
