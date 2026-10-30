import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LarmError } from "../domains/larm";
import { SearchError } from "../domains/search";
import { createApp } from "./app";
import { resolveConfig } from "./config";
import { openRuntime, type Runtime } from "./runtime";

const API = "api-token-0123456789abcdef0123";
const MCP = "mcp-token-0123456789abcdef0123";
const LARM_SECRET = "larm-control-secret-xyz";

const dirs: string[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.close();
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

async function setup(env: Record<string, string> = {}) {
	const dir = mkdtempSync(join(tmpdir(), "context-still-app-"));
	dirs.push(dir);
	const config = resolveConfig(
		{ CONTEXT_STILL_DB: join(dir, "db.sqlite3"), ...env },
		dir,
	);
	const runtime = await openRuntime(config, {
		fetch: (() => {
			throw new Error("no network in this test");
		}) as unknown as typeof fetch,
	});
	runtimes.push(runtime);
	const app = createApp(runtime, { api: API, mcp: MCP });
	const call = (
		path: string,
		init: RequestInit = {},
		token: string | null = API,
	) =>
		app.request(path, {
			...init,
			headers: {
				...(token ? { authorization: `Bearer ${token}` } : {}),
				...(init.body ? { "content-type": "application/json" } : {}),
				...(init.headers as Record<string, string> | undefined),
			},
		});
	return { app, runtime, call, dir };
}

test("GET /api/health needs no token", async () => {
	const { call } = await setup();
	const res = await call("/api/health", {}, null);
	expect(res.status).toBe(200);
	expect(await res.json()).toEqual({ ok: true, version: "2.0.0-alpha.0" });
});

test("/api/settings: 401 without or with a wrong token, 200 with the API token", async () => {
	const { call } = await setup();
	for (const token of [null, "wrong-token-wrong-token-1234", MCP]) {
		const res = await call("/api/settings", {}, token);
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate")).toBe("Bearer");
		expect(await res.json()).toEqual({ error: "unauthorized" });
	}
	const res = await call("/api/settings");
	expect(res.status).toBe(200);
	const body = (await res.json()) as any;
	expect(body.settings).toEqual({
		revision: 0,
		larm: {
			baseUrl: null,
			audience: null,
			embeddingProfile: "embeddingCanary",
		},
	});
	expect(body.diagnostics).toMatchObject({
		version: 1,
		keyError: null,
		credentialCount: 0,
	});
	expect(body.secrets).toEqual({ larmToken: { present: false } });
	// Other methods and unknown paths are covered by the same gate.
	expect(
		(await call("/api/settings/larm", { method: "PUT", body: "{}" }, null))
			.status,
	).toBe(401);
	expect((await call("/api/nope", {}, null)).status).toBe(401);
	expect((await call("/api/nope")).status).toBe(404);
});

test("settings never expose a secret, only whether the LARM token exists", async () => {
	const { runtime, call } = await setup({ LARM_API_TOKEN: LARM_SECRET });
	await runtime.settings.setCredential("larm.token", "stored-secret-value-42");
	const text = await (await call("/api/settings")).text();
	expect(text).not.toContain(LARM_SECRET);
	expect(text).not.toContain("stored-secret-value-42");
	expect(JSON.parse(text).secrets).toEqual({ larmToken: { present: true } });
	expect(JSON.parse(text).diagnostics.credentialCount).toBe(1);
	const status = await (await call("/api/larm/status")).text();
	expect(status).not.toContain(LARM_SECRET);
	expect(JSON.parse(status)).toEqual({
		configured: false,
		tokenPresent: true,
		connection: "none",
		lastError: null,
	});
});

test("PUT /api/settings/larm sets and clears the base URL", async () => {
	const { call } = await setup();
	const put = (body: unknown) =>
		call("/api/settings/larm", { method: "PUT", body: JSON.stringify(body) });
	const set = await put({ baseUrl: "http://127.0.0.1:4500/" });
	expect(set.status).toBe(200);
	expect(((await set.json()) as any).larm.baseUrl).toBe(
		"http://127.0.0.1:4500",
	);
	expect(
		((await (await call("/api/settings")).json()) as any).settings.larm.baseUrl,
	).toBe("http://127.0.0.1:4500");
	expect(
		((await (await call("/api/larm/status")).json()) as any).configured,
	).toBe(true);
	const cleared = await put({ baseUrl: null });
	expect(((await cleared.json()) as any).larm.baseUrl).toBeNull();
	const bad = await put({ baseUrl: "file:///etc/passwd" });
	expect(bad.status).toBe(400);
	expect(await bad.json()).toEqual({ error: "invalid_larm_settings" });
	for (const body of [
		{},
		{ baseUrl: 1 },
		{ baseUrl: null, audience: "same-host" },
	]) {
		const res = await put(body);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "invalid_input" });
	}
	const notJson = await call("/api/settings/larm", {
		method: "PUT",
		body: "{",
	});
	expect(notJson.status).toBe(400);
});

test("errors answer { error: code } with the status of the table; unknown ones are 500", async () => {
	const { app, call } = await setup();
	const cases: [unknown, number, string][] = [
		[new LarmError("larm_busy", 1000), 503, "larm_busy"],
		[new LarmError("larm_provider_conflict"), 409, "larm_provider_conflict"],
		[new SearchError("invalid_query"), 400, "invalid_query"],
		[new SearchError("space_not_allowed"), 403, "space_not_allowed"],
		[new Error("not_implemented"), 501, "not_implemented"],
		[
			new Error("database_writer_queue_full"),
			503,
			"database_writer_queue_full",
		],
		[new Error("boom with a secret: hunter2"), 500, "internal_error"],
		[new Error("migration_checksum_mismatch:x"), 500, "internal_error"],
	];
	cases.forEach(([error], i) =>
		app.get(`/api/boom/${i}`, () => {
			throw error;
		}),
	);
	for (const [i, [, status, code]] of cases.entries()) {
		const res = await call(`/api/boom/${i}`);
		expect(res.status).toBe(status);
		expect(await res.json()).toEqual({ error: code });
	}
});
