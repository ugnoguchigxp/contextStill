import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createFileExclusive } from "../../../infrastructure/atomic-file";
import { getLogger } from "../../../infrastructure/logger";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import {
	CREDENTIAL_ID_PATTERN,
	defaultSettings,
	larmPatchSchema,
	settingsSchema,
	type LarmPatch,
	type Settings,
	type SettingsDiagnostics,
	type SettingsKeyError,
} from "../contracts";
import {
	countCredentialRows,
	getCredentialRow,
	listCredentialRows,
	putCredentialRow,
	readSettings,
	saveSettings,
} from "../repository";

export interface SettingsService {
	get(): Settings;
	/** Changes the LARM connection. The revision moves only when something changed. */
	setLarm(patch: LarmPatch): Promise<Settings>;
	/** Stores `plaintext` encrypted under the master key, bound to `id`. */
	setCredential(id: string, plaintext: string): Promise<void>;
	hasCredential(id: string): boolean;
	/** The decrypted credential, or null when none is stored. */
	credential(id: string): string | null;
	diagnostics(): SettingsDiagnostics;
}

export interface CreateSettingsOptions {
	dbPath: string;
	/** Directory of `settings.key` (0700). Defaults to `<dbDir>/keys`. */
	keyDir?: string;
	/** Only `CONTEXT_STILL_SECRET_KEY` (base64, 32 bytes) is read; it wins over the key file. */
	env?: Record<string, string | undefined>;
	now?: () => Date;
}

const log = getLogger("settings");
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** An existing key directory is never chmod-ed; a mode wider than 0700 is only reported. */
function warnIfPermissive(keyDir: string) {
	try {
		if (statSync(keyDir).mode & 0o077)
			log.warn("settings.key_directory_permissive", {
				reason: "directory_permissive",
			});
	} catch {
		/* a missing directory is reported by the read that follows */
	}
}

const aad = (rowId: string) => Buffer.from(`contextstill:settings:v2:${rowId}`);

/** v2.<iv>.<tag>.<bytes>, authenticated against the credential row it belongs to. */
function encrypt(key: Buffer, value: string, rowId: string): string {
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv("aes-256-gcm", key, iv, {
		authTagLength: TAG_BYTES,
	});
	cipher.setAAD(aad(rowId));
	const bytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
	return [
		"v2",
		...[iv, cipher.getAuthTag(), bytes].map((b) => b.toString("base64")),
	].join(".");
}

function decrypt(key: Buffer, value: string, rowId: string): string {
	const [version, ...parts] = value.split(".");
	if (version !== "v2" || parts.length !== 3) throw new Error("secret_invalid");
	const [iv, tag, bytes] = parts.map((s) => Buffer.from(s, "base64")) as [
		Buffer,
		Buffer,
		Buffer,
	];
	// Fixed sizes: a shorter tag would weaken authentication, another IV length is not ours.
	if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES)
		throw new Error("secret_invalid");
	try {
		const decipher = createDecipheriv("aes-256-gcm", key, iv, {
			authTagLength: TAG_BYTES,
		});
		decipher.setAAD(aad(rowId));
		decipher.setAuthTag(tag);
		return Buffer.concat([decipher.update(bytes), decipher.final()]).toString(
			"utf8",
		);
	} catch {
		// The cipher's own message can describe the input; callers get a fixed code.
		throw new Error("secret_invalid");
	}
}

/** An origin only: the LARM control API is addressed by scheme, host and port. */
function normalizeBaseUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		throw new Error("invalid_larm_settings");
	}
	if (
		(url.protocol !== "http:" && url.protocol !== "https:") ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	)
		throw new Error("invalid_larm_settings");
	return url.origin;
}

export async function createSettings(
	store: SqliteStore,
	options: CreateSettingsOptions,
): Promise<SettingsService> {
	const env = options.env ?? {};
	const now = options.now ?? (() => new Date());
	const keyDir = options.keyDir || join(dirname(options.dbPath), "keys");
	const keyPath = join(keyDir, "settings.key");
	let key: Buffer | null = null;
	let keyError: SettingsKeyError | null = null;
	let keySource: "env" | "file" | null = null;

	try {
		const fromEnv = env.CONTEXT_STILL_SECRET_KEY?.trim();
		if (fromEnv) {
			key = Buffer.from(fromEnv, "base64");
			keySource = "env";
		} else if (existsSync(keyPath)) {
			// Loose permissions on the key file are tightened, not trusted.
			if (statSync(keyPath).mode & 0o077) chmodSync(keyPath, 0o600);
			warnIfPermissive(keyDir);
			key = readFileSync(keyPath);
			keySource = "file";
		} else if (store.read(countCredentialRows) > 0) {
			// Ciphertext without a key: never make a new key, that would orphan it silently.
			throw new Error("secret_key_unavailable");
		} else {
			// Only a directory created here is made owner-only; an existing one is left as it is.
			if (existsSync(keyDir)) warnIfPermissive(keyDir);
			else mkdirSync(keyDir, { recursive: true, mode: 0o700 });
			key = randomBytes(32);
			// A concurrent creator won the race: use the key it wrote.
			if (!createFileExclusive(keyPath, key)) key = readFileSync(keyPath);
			keySource = "file";
		}
		if (key.length !== 32) throw new Error("secret_key_invalid");
		// Existing ciphertext must open with this key and stay bound to its own row.
		for (const row of store.read(listCredentialRows))
			decrypt(key, row.encrypted, row.id);
	} catch (error) {
		keyError =
			(error as Error).message === "secret_key_invalid"
				? "secret_key_invalid"
				: "secret_key_unavailable";
		key = null;
		keySource = null;
	}

	await store.write((db) => {
		if (!readSettings(db))
			saveSettings(db, defaultSettings, now().toISOString());
	});

	const current = (): Settings => {
		const settings = store.read(readSettings);
		if (!settings) throw new Error("settings_missing");
		return settings;
	};

	const checkId = (id: string) => {
		if (!CREDENTIAL_ID_PATTERN.test(id))
			throw new Error("invalid_credential_id");
	};
	const needKey = (): Buffer => {
		if (!key) throw new Error(keyError ?? "secret_key_unavailable");
		return key;
	};

	return {
		get: current,
		async setLarm(patch) {
			const parsed = larmPatchSchema.safeParse(patch);
			if (!parsed.success) throw new Error("invalid_larm_settings");
			const change = parsed.data;
			return store.write((db) => {
				const before = readSettings(db) ?? defaultSettings;
				const larm = { ...before.larm, ...change };
				if (typeof larm.baseUrl === "string")
					larm.baseUrl = normalizeBaseUrl(larm.baseUrl);
				const next = settingsSchema.safeParse({
					revision: before.revision + 1,
					larm,
				});
				if (!next.success) throw new Error("invalid_larm_settings");
				if (JSON.stringify(next.data.larm) === JSON.stringify(before.larm))
					return before;
				saveSettings(db, next.data, now().toISOString());
				return next.data;
			});
		},
		async setCredential(id, plaintext) {
			checkId(id);
			if (plaintext === "") throw new Error("invalid_credential_id");
			const master = needKey();
			const encrypted = encrypt(master, plaintext, id);
			await store.write((db) =>
				putCredentialRow(db, id, encrypted, now().toISOString()),
			);
		},
		hasCredential(id) {
			checkId(id);
			return store.read((db) => getCredentialRow(db, id)) !== null;
		},
		credential(id) {
			checkId(id);
			const row = store.read((db) => getCredentialRow(db, id));
			return row === null ? null : decrypt(needKey(), row, id);
		},
		diagnostics() {
			return {
				version: 1,
				revision: current().revision,
				keyError,
				keySource,
				credentialCount: store.read(countCredentialRows),
			};
		},
	};
}
