import type { Migration } from "../../../infrastructure/sqlite";

export const migrations: readonly Migration[] = [
	{
		id: "legacy/0001-init",
		after: [],
		sql: `
CREATE TABLE legacy_import_runs (
  id TEXT PRIMARY KEY,
  importer_version TEXT NOT NULL,
  snapshot_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  report_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(report_json))
) STRICT;
CREATE TABLE legacy_import_map (
  legacy_table TEXT NOT NULL,
  legacy_id TEXT NOT NULL,
  target_table TEXT NOT NULL,
  target_id TEXT NOT NULL,
  legacy_digest TEXT NOT NULL,
  import_run_id TEXT NOT NULL REFERENCES legacy_import_runs(id),
  imported_at TEXT NOT NULL,
  PRIMARY KEY (legacy_table, legacy_id)
) STRICT;
CREATE INDEX legacy_import_map_target_idx ON legacy_import_map(target_table, target_id);
`,
	},
];
