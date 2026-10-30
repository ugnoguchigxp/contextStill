import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { ConfigError, resolveConfig } from "./config";

const repo = "/work/contextStill";
const code = (fn: () => unknown) => {
	try {
		fn();
	} catch (error) {
		return error instanceof ConfigError ? error.code : String(error);
	}
	return "no error";
};

test("defaults", () => {
	const config = resolveConfig({}, repo);
	expect(config).toEqual({
		dbPath: join(repo, "data", "context-still.sqlite3"),
		keyDir: join(repo, "data", "keys"),
		secretKey: undefined,
		apiToken: undefined,
		mcpToken: undefined,
		host: "127.0.0.1",
		port: 39181,
		larmToken: undefined,
	});
});

test("the database path is made absolute, relative to the repository", () => {
	expect(
		resolveConfig({ CONTEXT_STILL_DB: "data/x/y.sqlite3" }, repo).dbPath,
	).toBe(join(repo, "data", "x", "y.sqlite3"));
	const config = resolveConfig(
		{ CONTEXT_STILL_DB: "/var/tmp/a/db.sqlite3" },
		repo,
	);
	expect(config.dbPath).toBe("/var/tmp/a/db.sqlite3");
	expect(config.keyDir).toBe("/var/tmp/a/keys");
	expect(
		resolveConfig(
			{ CONTEXT_STILL_DB: "/var/tmp/a/db.sqlite3", CONTEXT_STILL_KEY_DIR: "k" },
			repo,
		).keyDir,
	).toBe(join(repo, "k"));
});

test("the in-memory database is refused", () => {
	expect(
		code(() => resolveConfig({ CONTEXT_STILL_DB: ":memory:" }, repo)),
	).toBe("db_path_invalid");
});

test("v1 locations are refused as the database or the key directory", () => {
	const home = homedir();
	for (const reserved of [
		join(
			home,
			"Code",
			"contextStill-legacy",
			"data",
			"context-still-core.sqlite",
		),
		join(home, "Code", "contextStill-legacy"),
		join(home, "Library", "Application Support", "contextStill", "x.sqlite3"),
		join(home, "Code", "contextStill-db-backup-20261029", "a.sqlite"),
	]) {
		expect(
			code(() => resolveConfig({ CONTEXT_STILL_DB: reserved }, repo)),
		).toBe("path_reserved_by_legacy");
		expect(
			code(() =>
				resolveConfig(
					{
						CONTEXT_STILL_KEY_DIR: reserved,
						CONTEXT_STILL_DB: "/var/tmp/d/db",
					},
					repo,
				),
			),
		).toBe("path_reserved_by_legacy");
	}
	// A sibling that merely shares the prefix is not reserved.
	expect(
		code(() =>
			resolveConfig(
				{
					CONTEXT_STILL_DB: join(homedir(), "Code", "contextStill-other", "db"),
				},
				repo,
			),
		),
	).toBe("no error");
	expect(
		code(() =>
			resolveConfig(
				{ CONTEXT_STILL_DB: "~/Code/contextStill-legacy/db" },
				repo,
			),
		),
	).toBe("path_reserved_by_legacy");
});

test("ports 39171 and 39172 and out-of-range ports are refused", () => {
	for (const port of ["39171", "39172"])
		expect(code(() => resolveConfig({ CONTEXT_STILL_PORT: port }, repo))).toBe(
			"port_reserved_by_legacy",
		);
	for (const port of ["80", "1023", "65536", "abc", "-1", "39181.5", ""]) {
		const outcome = code(() =>
			resolveConfig({ CONTEXT_STILL_PORT: port }, repo),
		);
		// An empty value is "unset" and takes the default.
		expect(outcome).toBe(port === "" ? "no error" : "port_invalid");
	}
	expect(resolveConfig({ CONTEXT_STILL_PORT: "40000" }, repo).port).toBe(40000);
});

test("only loopback hosts are accepted", () => {
	for (const host of ["127.0.0.1", "::1", "localhost"])
		expect(resolveConfig({ CONTEXT_STILL_HOST: host }, repo).host).toBe(host);
	for (const host of ["0.0.0.0", "192.168.0.2", "example.com", "::"])
		expect(code(() => resolveConfig({ CONTEXT_STILL_HOST: host }, repo))).toBe(
			"host_not_loopback",
		);
});

test("tokens and the secret key are validated", () => {
	expect(
		code(() => resolveConfig({ CONTEXT_STILL_API_TOKEN: "short" }, repo)),
	).toBe("api_token_too_short");
	expect(
		code(() => resolveConfig({ CONTEXT_STILL_MCP_TOKEN: "short" }, repo)),
	).toBe("mcp_token_too_short");
	const same = "x".repeat(24);
	expect(
		code(() =>
			resolveConfig(
				{ CONTEXT_STILL_API_TOKEN: same, CONTEXT_STILL_MCP_TOKEN: same },
				repo,
			),
		),
	).toBe("tokens_not_distinct");
	expect(
		code(() => resolveConfig({ CONTEXT_STILL_SECRET_KEY: "AAAA" }, repo)),
	).toBe("secret_key_invalid");
	const key = Buffer.alloc(32, 7).toString("base64");
	expect(resolveConfig({ CONTEXT_STILL_SECRET_KEY: key }, repo).secretKey).toBe(
		key,
	);
});

test("the LARM token comes from LARM_API_TOKEN or LARM_CONTROL_TOKEN", () => {
	expect(resolveConfig({ LARM_API_TOKEN: "a" }, repo).larmToken).toBe("a");
	expect(resolveConfig({ LARM_CONTROL_TOKEN: "b" }, repo).larmToken).toBe("b");
	expect(
		resolveConfig({ LARM_API_TOKEN: "a", LARM_CONTROL_TOKEN: "b" }, repo)
			.larmToken,
	).toBe("a");
});

test("v1 environment variables change nothing", () => {
	const legacy = {
		CONTEXT_STILL_SQLITE_CORE_PATH: "/etc/passwd",
		CONTEXT_STILL_APP_DATA_DIR: "/tmp/elsewhere",
		CONTEXT_STILL_DB_BACKEND: "postgres",
		CONTEXT_STILL_API_HOST: "0.0.0.0",
		CONTEXT_STILL_MCP_PORT: "39171",
		CONTEXT_STILL_MCP_HOST: "0.0.0.0",
		CONTEXT_STILL_ADMIN_API_TOKEN: "y".repeat(30),
		CONTEXT_STILL_ADMIN_API_PORT: "39172",
	};
	const base = {
		CONTEXT_STILL_DB: "data/a.sqlite3",
		CONTEXT_STILL_PORT: "40001",
	};
	expect(resolveConfig({ ...base, ...legacy }, repo)).toEqual(
		resolveConfig(base, repo),
	);
	expect(resolveConfig(legacy, repo)).toEqual(resolveConfig({}, repo));
});
