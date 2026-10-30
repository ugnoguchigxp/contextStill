import { afterEach, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import { createSettings } from "../index";
import { migrations } from "../repository";

const dirs: string[] = [];
const stores: SqliteStore[] = [];
function setup() {
	const dir = mkdtempSync(join(tmpdir(), "context-still-settings-"));
	dirs.push(dir);
	const dbPath = join(dir, "db.sqlite3");
	const open = () => {
		const store = openStore(dbPath, migrations);
		stores.push(store);
		return store;
	};
	return { dir, dbPath, keyDir: join(dir, "keys"), open };
}
async function reopen(
	s: ReturnType<typeof setup>,
	env?: Record<string, string | undefined>,
) {
	const index = stores.findIndex(Boolean);
	if (index >= 0) await stores.splice(index, 1)[0]!.close();
	const store = s.open();
	return {
		store,
		settings: await createSettings(store, {
			dbPath: s.dbPath,
			keyDir: s.keyDir,
			env,
		}),
	};
}
afterEach(async () => {
	for (const store of stores.splice(0)) await store.close();
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

const SECRET = "plaintext-secret-value-ABC123";

test("the key file is created 0600 in a 0700 directory and stays", async () => {
	const s = setup();
	const { settings } = await reopen(s);
	await settings.setCredential("larm.token", SECRET);
	expect(statSync(s.keyDir).mode & 0o777).toBe(0o700);
	expect(statSync(join(s.keyDir, "settings.key")).mode & 0o777).toBe(0o600);
	expect(readFileSync(join(s.keyDir, "settings.key")).length).toBe(32);
	expect(settings.credential("larm.token")).toBe(SECRET);
	// A restart reads the same key.
	const again = await reopen(s);
	expect(again.settings.credential("larm.token")).toBe(SECRET);
	expect(again.settings.diagnostics().keyError).toBeNull();
});

test("CONTEXT_STILL_SECRET_KEY wins over the key file and no file is created for it", async () => {
	const s = setup();
	const envKey = Buffer.alloc(32, 9).toString("base64");
	const { settings } = await reopen(s, { CONTEXT_STILL_SECRET_KEY: envKey });
	await settings.setCredential("larm.token", SECRET);
	expect(existsSync(join(s.keyDir, "settings.key"))).toBe(false);
	expect(settings.diagnostics().keySource).toBe("env");
	// The same key opens it; another key does not.
	const same = await reopen(s, { CONTEXT_STILL_SECRET_KEY: envKey });
	expect(same.settings.credential("larm.token")).toBe(SECRET);
	const other = await reopen(s, {
		CONTEXT_STILL_SECRET_KEY: Buffer.alloc(32, 1).toString("base64"),
	});
	expect(other.settings.diagnostics().keyError).toBe("secret_key_unavailable");
	expect(() => other.settings.credential("larm.token")).toThrow(
		"secret_key_unavailable",
	);
});

test("an env key that is not 32 bytes is reported, not used", async () => {
	const s = setup();
	const { settings } = await reopen(s, { CONTEXT_STILL_SECRET_KEY: "AAAA" });
	expect(settings.diagnostics().keyError).toBe("secret_key_invalid");
	await expect(settings.setCredential("larm.token", SECRET)).rejects.toThrow(
		"secret_key_invalid",
	);
});

test("ciphertext without a key is a keyError and no new key is made", async () => {
	const s = setup();
	const first = await reopen(s);
	await first.settings.setCredential("larm.token", SECRET);
	rmSync(join(s.keyDir, "settings.key"));
	const lost = await reopen(s);
	expect(lost.settings.diagnostics().keyError).toBe("secret_key_unavailable");
	expect(existsSync(join(s.keyDir, "settings.key"))).toBe(false);
	expect(readdirSync(s.keyDir)).toEqual([]);
	expect(() => lost.settings.credential("larm.token")).toThrow(
		"secret_key_unavailable",
	);
	await expect(lost.settings.setCredential("other", "x")).rejects.toThrow(
		"secret_key_unavailable",
	);
	// The stored ciphertext is untouched and readable again once the key is back.
	expect(lost.settings.hasCredential("larm.token")).toBe(true);
});

test("the AAD binds ciphertext to its row: moving it to another id fails to decrypt", async () => {
	const s = setup();
	const { store, settings } = await reopen(s);
	await settings.setCredential("a.token", SECRET);
	await store.write((db) =>
		db
			.query(
				`INSERT INTO settings_credentials (id, encrypted, updated_at)
				 SELECT 'b.token', encrypted, updated_at FROM settings_credentials WHERE id = 'a.token'`,
			)
			.run(),
	);
	expect(settings.credential("a.token")).toBe(SECRET);
	expect(() => settings.credential("b.token")).toThrow();
	// A restart notices the foreign row and refuses the key as a whole.
	const again = await reopen(s);
	expect(again.settings.diagnostics().keyError).toBe("secret_key_unavailable");
});

test("stored credentials are v2 ciphertext and diagnostics never show a secret", async () => {
	const s = setup();
	const { store, settings } = await reopen(s);
	await settings.setCredential("larm.token", SECRET);
	const row = store.read((db) =>
		db.query("SELECT encrypted FROM settings_credentials").get(),
	) as { encrypted: string };
	expect(row.encrypted.startsWith("v2.")).toBe(true);
	expect(row.encrypted.split(".")).toHaveLength(4);
	expect(row.encrypted).not.toContain(SECRET);
	const everything = JSON.stringify([
		settings.diagnostics(),
		settings.get(),
		readFileSync(join(s.dir, "db.sqlite3")).toString("latin1").includes(SECRET),
	]);
	expect(everything).not.toContain(SECRET);
	expect(settings.diagnostics()).toEqual({
		version: 1,
		revision: 0,
		keyError: null,
		keySource: "file",
		credentialCount: 1,
	});
});

test("credential ids are fixed names", async () => {
	const s = setup();
	const { settings } = await reopen(s);
	for (const id of ["", "A", "../x", "a b", "x".repeat(65)]) {
		expect(() => settings.hasCredential(id)).toThrow("invalid_credential_id");
		await expect(settings.setCredential(id, "v")).rejects.toThrow(
			"invalid_credential_id",
		);
	}
	expect(settings.hasCredential("missing")).toBe(false);
	expect(settings.credential("missing")).toBeNull();
});

test("only the fixed 12-byte IV and 16-byte tag are accepted; a mangled row is secret_invalid", async () => {
	const s = setup();
	const { store, settings } = await reopen(s);
	await settings.setCredential("a.token", SECRET);
	const original = store.read(
		(db) =>
			(
				db
					.query(
						"SELECT encrypted FROM settings_credentials WHERE id = 'a.token'",
					)
					.get() as { encrypted: string }
			).encrypted,
	);
	const [version, iv, tag, bytes] = original.split(".") as [
		string,
		string,
		string,
		string,
	];
	const variants = {
		shortTag: [
			version,
			iv,
			Buffer.from(tag, "base64").subarray(0, 8).toString("base64"),
			bytes,
		],
		longIv: [version, Buffer.alloc(16, 1).toString("base64"), tag, bytes],
		shortIv: [version, Buffer.alloc(8, 1).toString("base64"), tag, bytes],
		emptyTag: [version, iv, "", bytes],
	};
	for (const [name, parts] of Object.entries(variants)) {
		await store.write((db) =>
			db
				.query(
					"UPDATE settings_credentials SET encrypted = ? WHERE id = 'a.token'",
				)
				.run(parts.join(".")),
		);
		try {
			settings.credential("a.token");
			throw new Error(`${name} was accepted`);
		} catch (error) {
			expect((error as Error).message).toBe("secret_invalid");
		}
	}
	await store.write((db) =>
		db
			.query(
				"UPDATE settings_credentials SET encrypted = ? WHERE id = 'a.token'",
			)
			.run(original),
	);
	expect(settings.credential("a.token")).toBe(SECRET);
});

test("an existing key directory keeps its mode (only a warning); a new one is 0700", async () => {
	const s = setup();
	mkdirSync(s.keyDir, { mode: 0o755 });
	chmodSync(s.keyDir, 0o755);
	const previous = process.env.NODE_ENV;
	process.env.NODE_ENV = "production";
	const written: string[] = [];
	const realWrite = process.stderr.write.bind(process.stderr);
	process.stderr.write = ((chunk: string | Uint8Array) => {
		written.push(String(chunk));
		return true;
	}) as typeof process.stderr.write;
	try {
		const first = await reopen(s);
		await first.settings.setCredential("larm.token", SECRET);
		await reopen(s);
	} finally {
		process.stderr.write = realWrite;
		process.env.NODE_ENV = previous;
	}
	expect(statSync(s.keyDir).mode & 0o777).toBe(0o755);
	expect(written.join("")).toContain("settings.key_directory_permissive");
	expect(written.join("")).not.toContain(SECRET);
});
