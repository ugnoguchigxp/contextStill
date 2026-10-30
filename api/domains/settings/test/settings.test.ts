import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import { createSettings, type SettingsService } from "../index";
import { migrations } from "../repository";

const dirs: string[] = [];
const stores: SqliteStore[] = [];
async function fresh(): Promise<SettingsService> {
	const dir = mkdtempSync(join(tmpdir(), "context-still-settings-doc-"));
	dirs.push(dir);
	const store = openStore(join(dir, "db.sqlite3"), migrations);
	stores.push(store);
	return createSettings(store, {
		dbPath: join(dir, "db.sqlite3"),
		keyDir: join(dir, "keys"),
	});
}
afterEach(async () => {
	for (const store of stores.splice(0)) await store.close();
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

test("the default document", async () => {
	const settings = await fresh();
	expect(settings.get()).toEqual({
		revision: 0,
		larm: {
			baseUrl: null,
			audience: null,
			embeddingProfile: "embeddingCanary",
			llmProfile: "contextStill",
		},
	});
});

test("setLarm normalizes the base URL to an origin and bumps the revision once per change", async () => {
	const settings = await fresh();
	const first = await settings.setLarm({ baseUrl: " http://127.0.0.1:4000/ " });
	expect(first.larm.baseUrl).toBe("http://127.0.0.1:4000");
	expect(first.revision).toBe(1);
	expect(
		(await settings.setLarm({ baseUrl: "http://127.0.0.1:4000" })).revision,
	).toBe(1);
	const second = await settings.setLarm({ audience: "saaa-desktop" });
	expect(second.revision).toBe(2);
	expect(second.larm.baseUrl).toBe("http://127.0.0.1:4000");
	const cleared = await settings.setLarm({ baseUrl: null });
	expect(cleared.larm.baseUrl).toBeNull();
	expect(settings.get()).toEqual(cleared);
});

test("setLarm refuses what is not an http(s) origin", async () => {
	const settings = await fresh();
	for (const baseUrl of [
		"ftp://host",
		"not a url",
		"http://user:pw@host",
		"http://host/?q=1",
		"http://host/#x",
	])
		await expect(settings.setLarm({ baseUrl })).rejects.toThrow(
			"invalid_larm_settings",
		);
	await expect(
		settings.setLarm({ embeddingProfile: "" } as never),
	).rejects.toThrow("invalid_larm_settings");
	await expect(settings.setLarm({ extra: 1 } as never)).rejects.toThrow(
		"invalid_larm_settings",
	);
	expect(settings.get().revision).toBe(0);
});
