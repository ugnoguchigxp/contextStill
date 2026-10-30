import type { Database } from "bun:sqlite";
import { settingsSchema, type Settings } from "../contracts";

export { migrations } from "./migrations";

/** The stored document, strictly parsed; null before the first save. */
export function readSettings(db: Database): Settings | null {
	const row = db
		.query("SELECT document FROM settings_document WHERE id = 1")
		.get() as { document: string } | null;
	return row ? settingsSchema.parse(JSON.parse(row.document)) : null;
}

export function saveSettings(
	db: Database,
	value: Settings,
	updatedAt: string,
): void {
	db.query(
		`INSERT INTO settings_document (id, revision, document, updated_at) VALUES (1, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET revision = excluded.revision,
		   document = excluded.document, updated_at = excluded.updated_at`,
	).run(value.revision, JSON.stringify(value), updatedAt);
}

export function listCredentialRows(
	db: Database,
): { id: string; encrypted: string }[] {
	return db.query("SELECT id, encrypted FROM settings_credentials").all() as {
		id: string;
		encrypted: string;
	}[];
}

export function getCredentialRow(db: Database, id: string): string | null {
	const row = db
		.query("SELECT encrypted FROM settings_credentials WHERE id = ?")
		.get(id) as { encrypted: string } | null;
	return row?.encrypted ?? null;
}

export function putCredentialRow(
	db: Database,
	id: string,
	encrypted: string,
	updatedAt: string,
): void {
	db.query(
		`INSERT INTO settings_credentials (id, encrypted, updated_at) VALUES (?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET encrypted = excluded.encrypted, updated_at = excluded.updated_at`,
	).run(id, encrypted, updatedAt);
}

export function countCredentialRows(db: Database): number {
	return (
		db.query("SELECT count(*) AS n FROM settings_credentials").get() as {
			n: number;
		}
	).n;
}
