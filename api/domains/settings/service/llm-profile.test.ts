import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import {
	defaultSettings,
	larmSettingsSchema,
	settingsSchema,
} from "../contracts";
import { migrations } from "../repository";
import { createSettings } from "./index";

const dirs: string[] = [];
const stores: SqliteStore[] = [];
afterEach(async () => {
	for (const store of stores.splice(0)) await store.close();
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
async function fresh() {
	const dir = mkdtempSync(join(tmpdir(), "context-still-settings-"));
	dirs.push(dir);
	const store = openStore(join(dir, "db.sqlite3"), migrations);
	stores.push(store);
	return {
		store,
		settings: await createSettings(store, { dbPath: join(dir, "db.sqlite3") }),
	};
}

test("llmProfile defaults to contextStill, also for a document stored before N2", () => {
	expect(defaultSettings.larm.llmProfile).toBe("contextStill");
	const old = settingsSchema.parse({
		revision: 3,
		larm: {
			baseUrl: "http://127.0.0.1:1",
			audience: null,
			embeddingProfile: "embeddingCanary",
		},
	});
	expect(old.larm.llmProfile).toBe("contextStill");
	expect(larmSettingsSchema.shape.llmProfile.safeParse("").success).toBe(false);
});

test("a patch that leaves llmProfile out keeps the stored value; one that sets it changes it", async () => {
	const { settings } = await fresh();
	const set = await settings.setLarm({ llmProfile: "custom" });
	expect(set.larm.llmProfile).toBe("custom");
	const url = await settings.setLarm({ baseUrl: "http://127.0.0.1:4000" });
	expect(url.larm.llmProfile).toBe("custom");
	expect(url.revision).toBe(2);
	expect((await settings.setLarm({ llmProfile: "custom" })).revision).toBe(2);
	await expect(settings.setLarm({ llmProfile: "" })).rejects.toThrow(
		"invalid_larm_settings",
	);
});
