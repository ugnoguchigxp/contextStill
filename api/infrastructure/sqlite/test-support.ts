import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type MigrationInput, openStore, type SqliteStore } from "./index";

/**
 * Test support: a real store (OS lock, WAL, migrations) in a fresh temporary directory.
 * `dispose` closes it and removes the directory. Only tests import this.
 */
export function tempStore(migrations: readonly MigrationInput[]): {
	store: SqliteStore;
	dir: string;
	dispose(): Promise<void>;
} {
	const dir = mkdtempSync(join(tmpdir(), "context-still-test-"));
	const store = openStore(join(dir, "db.sqlite3"), migrations);
	return {
		store,
		dir,
		async dispose() {
			await store.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
