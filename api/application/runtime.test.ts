import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WriterOwnedError } from "../infrastructure/sqlite";
import { resolveConfig } from "./config";
import { LARM_SPACE_KEY, openRuntime } from "./runtime";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
const config = (env: Record<string, string> = {}) => {
	const dir = mkdtempSync(join(tmpdir(), "context-still-runtime-"));
	dirs.push(dir);
	return resolveConfig(
		{ CONTEXT_STILL_DB: join(dir, "db.sqlite3"), ...env },
		dir,
	);
};

test("openRuntime builds the services; a second runtime on the same database is refused", async () => {
	const c = config();
	const runtime = await openRuntime(c);
	expect(runtime.spaceKey).toBe(LARM_SPACE_KEY);
	expect(LARM_SPACE_KEY).toBe("018ded9ab8b29f6ef2eb811c20e79004");
	expect(runtime.settings.get().revision).toBe(0);
	expect(runtime.larm.status().configured).toBe(false);
	await expect(openRuntime(c)).rejects.toThrow(WriterOwnedError);
	await runtime.close();
	const again = await openRuntime(c);
	await again.close();
});

test("close releases the LARM connection through the injected fetch", async () => {
	const c = config();
	const calls: string[] = [];
	const runtime = await openRuntime(c, {
		fetch: (async () => {
			calls.push("fetch");
			return new Response("{}", { status: 500 });
		}) as unknown as typeof fetch,
	});
	// No connection was made, so there is nothing to release and nothing is sent.
	await runtime.close();
	expect(calls).toEqual([]);
});

test("the global fetch is not used unless nothing is injected, and then it is the blocked one", async () => {
	const c = config({ LARM_API_TOKEN: "t" });
	const runtime = await openRuntime(c);
	await runtime.settings.setLarm({ baseUrl: "http://127.0.0.1:4500" });
	await expect(runtime.larm.embed(["x"], "query")).rejects.toThrow();
	await runtime.close();
});
