import type { Migration } from "../../../infrastructure/sqlite";

export const migrations: readonly Migration[] = [
	{
		id: "sources/0001-init",
		after: [],
		sql: `
CREATE TABLE source_records (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('agent_log','document','web','research')),
  uri TEXT NOT NULL,
  title TEXT,
  content TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  space TEXT NOT NULL CHECK (space IN ('coding','general','eumenes','personal')),
  scope TEXT NOT NULL CHECK (scope IN ('global','repo')),
  repo_key TEXT,
  recorded_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (scope = 'repo' OR repo_key IS NULL)
) STRICT;
CREATE UNIQUE INDEX source_records_kind_uri_idx ON source_records(kind, uri);
CREATE INDEX source_records_filter_idx ON source_records(space, scope, repo_key);
CREATE TABLE source_fragments (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  source_id TEXT NOT NULL REFERENCES source_records(id) ON DELETE CASCADE,
  locator TEXT NOT NULL,
  byte_start INTEGER,
  byte_end INTEGER,
  heading TEXT,
  content TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (source_id, locator),
  CHECK ((byte_start IS NULL) = (byte_end IS NULL)),
  CHECK (byte_start IS NULL OR (byte_start >= 0 AND byte_end >= byte_start))
) STRICT;
`,
	},
];
