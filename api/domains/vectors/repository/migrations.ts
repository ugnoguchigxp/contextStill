import type { Migration } from "../../../infrastructure/sqlite";

export const migrations: readonly Migration[] = [
	{
		id: "vectors/0001-init",
		after: [],
		sql: `
CREATE TABLE vector_spaces (
  space_key TEXT PRIMARY KEY,
  model_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  artifact_digest TEXT NOT NULL,
  dimension INTEGER NOT NULL CHECK (dimension > 0),
  descriptor_json TEXT NOT NULL CHECK (json_valid(descriptor_json)),
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE vectors (
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('knowledge','episode')),
  owner_id TEXT NOT NULL,
  space_key TEXT NOT NULL REFERENCES vector_spaces(space_key),
  content_digest TEXT NOT NULL,
  vector BLOB NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('legacy_import','larm')),
  verification TEXT NOT NULL CHECK (verification IN ('unverified','verified','mismatch','stale')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_kind, owner_id, space_key)
) STRICT;
CREATE INDEX vectors_scan_idx ON vectors(space_key, owner_kind, verification);
CREATE TABLE vector_verifications (
  id TEXT PRIMARY KEY,
  space_key TEXT NOT NULL REFERENCES vector_spaces(space_key),
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('knowledge','episode')),
  origin TEXT NOT NULL CHECK (origin IN ('legacy_import','larm')),
  sample_size INTEGER NOT NULL,
  min_cosine REAL,
  mean_cosine REAL,
  threshold_min REAL NOT NULL,
  threshold_mean REAL NOT NULL,
  passed INTEGER NOT NULL CHECK (passed IN (0,1)),
  detail_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail_json)),
  created_at TEXT NOT NULL
) STRICT;
`,
	},
];
