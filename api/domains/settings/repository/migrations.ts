import type { Migration } from "../../../infrastructure/sqlite";

export const migrations: readonly Migration[] = [
	{
		id: "settings/0001-init",
		after: [],
		sql: `
CREATE TABLE settings_document (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL,
  document TEXT NOT NULL CHECK (json_valid(document)),
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE settings_credentials (
  id TEXT PRIMARY KEY,
  encrypted TEXT NOT NULL CHECK (encrypted LIKE 'v2.%'),
  updated_at TEXT NOT NULL
) STRICT;
`,
	},
];
