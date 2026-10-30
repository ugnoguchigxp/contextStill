import type { Migration } from "../../../infrastructure/sqlite";

export const migrations: readonly Migration[] = [
	{
		id: "knowledge/0001-init",
		after: ["sources/0001-init"],
		sql: `
CREATE TABLE knowledge_items (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  handle TEXT NOT NULL UNIQUE,
  layer TEXT NOT NULL CHECK (layer IN ('atom','canonical')),
  type TEXT NOT NULL CHECK (type IN ('rule','procedure')),
  polarity TEXT NOT NULL CHECK (polarity IN ('positive','negative')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  applies_when_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(applies_when_json)),
  not_applies_when_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(not_applies_when_json)),
  steps_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(steps_json)),
  facets_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(facets_json)),
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  importance REAL NOT NULL CHECK (importance BETWEEN 0 AND 1),
  status TEXT NOT NULL CHECK (status IN ('candidate','active','superseded','retracted')),
  space TEXT NOT NULL CHECK (space IN ('coding','general','eumenes','personal')),
  scope TEXT NOT NULL CHECK (scope IN ('global','repo')),
  repo_key TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  valid_from TEXT,
  valid_until TEXT,
  content_digest TEXT NOT NULL,
  provenance_status TEXT NOT NULL
    CHECK (provenance_status IN ('resolved','external','source_missing','unresolved')),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (scope = 'repo' OR repo_key IS NULL)
) STRICT;
CREATE INDEX knowledge_items_filter_idx ON knowledge_items(status, layer, space, scope, repo_key);
CREATE TABLE knowledge_evidence (
  id TEXT PRIMARY KEY,
  knowledge_id TEXT NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('atom','source','fragment','episode','external')),
  target_id TEXT,
  external_ref TEXT,
  role TEXT NOT NULL CHECK (role IN ('derived_from','supports','refutes')),
  quote TEXT,
  confidence REAL CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  origin TEXT NOT NULL CHECK (origin IN ('legacy_import','pipeline','human')),
  created_at TEXT NOT NULL,
  CHECK ((target_kind = 'external') = (target_id IS NULL)),
  CHECK ((target_kind = 'external') = (external_ref IS NOT NULL))
) STRICT;
CREATE INDEX knowledge_evidence_item_idx ON knowledge_evidence(knowledge_id);
CREATE INDEX knowledge_evidence_target_idx ON knowledge_evidence(target_kind, target_id);
CREATE VIRTUAL TABLE knowledge_fts USING fts5(
  title, body, content='knowledge_items', content_rowid='seq', tokenize='trigram'
);
CREATE TRIGGER knowledge_fts_ai AFTER INSERT ON knowledge_items BEGIN
  INSERT INTO knowledge_fts(rowid, title, body) VALUES (new.seq, new.title, new.body);
END;
CREATE TRIGGER knowledge_fts_ad AFTER DELETE ON knowledge_items BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, title, body) VALUES ('delete', old.seq, old.title, old.body);
END;
CREATE TRIGGER knowledge_fts_au AFTER UPDATE OF title, body ON knowledge_items BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, title, body) VALUES ('delete', old.seq, old.title, old.body);
  INSERT INTO knowledge_fts(rowid, title, body) VALUES (new.seq, new.title, new.body);
END;
`,
	},
	{
		id: "knowledge/0002-canonical",
		after: ["knowledge/0001-init"],
		sql: `
ALTER TABLE knowledge_items ADD COLUMN situation TEXT NOT NULL DEFAULT '';
ALTER TABLE knowledge_items ADD COLUMN rationale TEXT NOT NULL DEFAULT '';
ALTER TABLE knowledge_items ADD COLUMN exceptions_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(exceptions_json));
ALTER TABLE knowledge_items ADD COLUMN examples_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(examples_json));
ALTER TABLE knowledge_items ADD COLUMN retrieval TEXT NOT NULL DEFAULT 'searchable'
  CHECK (retrieval IN ('searchable','evidence_only'));
CREATE INDEX knowledge_items_retrieval_idx ON knowledge_items(retrieval, status, layer, space);
DROP TRIGGER knowledge_fts_ai;
DROP TRIGGER knowledge_fts_ad;
DROP TRIGGER knowledge_fts_au;
DROP TABLE knowledge_fts;
CREATE VIRTUAL TABLE knowledge_fts USING fts5(
  title, situation, body, content='knowledge_items', content_rowid='seq', tokenize='trigram'
);
CREATE TRIGGER knowledge_fts_ai AFTER INSERT ON knowledge_items BEGIN
  INSERT INTO knowledge_fts(rowid, title, situation, body) VALUES (new.seq, new.title, new.situation, new.body);
END;
CREATE TRIGGER knowledge_fts_ad AFTER DELETE ON knowledge_items BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, title, situation, body)
  VALUES ('delete', old.seq, old.title, old.situation, old.body);
END;
CREATE TRIGGER knowledge_fts_au AFTER UPDATE OF title, situation, body ON knowledge_items BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, title, situation, body)
  VALUES ('delete', old.seq, old.title, old.situation, old.body);
  INSERT INTO knowledge_fts(rowid, title, situation, body) VALUES (new.seq, new.title, new.situation, new.body);
END;
INSERT INTO knowledge_fts(knowledge_fts) VALUES ('rebuild');
`,
	},
];
