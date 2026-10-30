import { afterEach, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ensureApiToken,
	ensureMcpToken,
	readApiToken,
	readMcpToken,
	resolveLarmToken,
} from "./auth-config";

const dirs: string[] = [];
const dbEnv = () => {
	const dir = mkdtempSync(join(tmpdir(), "context-still-auth-"));
	dirs.push(dir);
	return {
		dir,
		dbPath: join(dir, "context-still.sqlite3"),
		env: { CONTEXT_STILL_DB: join(dir, "context-still.sqlite3") },
	};
};
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

test("empty optional settings do not mask the exported LARM token", () => {
	const env = {
		LARM_API_TOKEN: "fixture-control",
		LARM_CONTROL_TOKEN: "",
	};
	expect(resolveLarmToken(env)).toBe("fixture-control");
	expect(resolveLarmToken({ LARM_CONTROL_TOKEN: "old-control" })).toBe(
		"old-control",
	);
});

test("api.token and mcp.token are created as 64 hex, mode 0600, in a 0700 dir", () => {
	const { dir, env } = dbEnv();
	const api = ensureApiToken(env, "unused");
	const mcp = ensureMcpToken(env, "unused");
	expect(api).toMatch(/^[0-9a-f]{64}$/);
	expect(mcp).toMatch(/^[0-9a-f]{64}$/);
	expect(api).not.toBe(mcp);
	expect(statSync(join(dir, "keys", "api.token")).mode & 0o777).toBe(0o600);
	expect(statSync(join(dir, "keys", "mcp.token")).mode & 0o777).toBe(0o600);
	expect(statSync(join(dir, "keys")).mode & 0o777).toBe(0o700);
	// Stable across calls; the read-only variants never create.
	expect(ensureApiToken(env, "unused")).toBe(api);
	expect(ensureMcpToken(env, "unused")).toBe(mcp);
	expect(readApiToken(env)).toBe(api);
	expect(readMcpToken(env)).toBe(mcp);
});

test("the default location follows the given database path", () => {
	const { dir, dbPath } = dbEnv();
	const token = ensureMcpToken({}, dbPath);
	expect(statSync(join(dir, "keys", "mcp.token")).mode & 0o777).toBe(0o600);
	expect(readMcpToken({}, dbPath)).toBe(token);
});

test("CONTEXT_STILL_KEY_DIR overrides the key directory", () => {
	const { dir, env } = dbEnv();
	const keys = join(dir, "elsewhere");
	const token = ensureApiToken({ ...env, CONTEXT_STILL_KEY_DIR: keys }, "x");
	expect(statSync(join(keys, "api.token")).mode & 0o777).toBe(0o600);
	expect(readApiToken({ CONTEXT_STILL_KEY_DIR: keys }, join(dir, "db"))).toBe(
		token,
	);
});

test("explicit tokens are used as is and must be at least 24 characters", () => {
	const explicit = "local-api-token-with-24-characters";
	expect(ensureApiToken({ CONTEXT_STILL_API_TOKEN: ` ${explicit} ` })).toBe(
		explicit,
	);
	expect(ensureMcpToken({ CONTEXT_STILL_MCP_TOKEN: explicit })).toBe(explicit);
	expect(() => ensureApiToken({ CONTEXT_STILL_API_TOKEN: "short" })).toThrow(
		"at least 24",
	);
	expect(() => ensureMcpToken({ CONTEXT_STILL_MCP_TOKEN: "short" })).toThrow(
		"at least 24",
	);
});

test("an invalid token file is rejected", () => {
	const { dir, env } = dbEnv();
	mkdirSync(join(dir, "keys"));
	writeFileSync(join(dir, "keys", "mcp.token"), "not-a-token");
	expect(() => ensureMcpToken(env, "x")).toThrow("token_file_invalid");
});

test("a missing token is reported by the read-only variants", () => {
	const { env } = dbEnv();
	expect(() => readApiToken(env)).toThrow("api_token_not_found");
	expect(() => readMcpToken(env)).toThrow("mcp_token_not_found");
});

test("the LARM token never determines the API token", () => {
	const a = dbEnv();
	const b = dbEnv();
	const first = ensureApiToken({ ...a.env, LARM_API_TOKEN: "fixture-control" });
	const second = ensureApiToken({
		...b.env,
		LARM_API_TOKEN: "fixture-control",
	});
	expect(first).not.toBe(second);
	expect(ensureApiToken({ ...a.env, LARM_API_TOKEN: "other" })).toBe(first);
});
