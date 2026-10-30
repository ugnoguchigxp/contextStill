import type { Migration } from "../../../infrastructure/sqlite";

export const migrations: readonly Migration[] = [
	{
		id: "experience/0001-init",
		after: ["sources/0001-init"],
		sql: `
CREATE TABLE episodes (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  handle TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  situation TEXT NOT NULL,
  intent TEXT NOT NULL DEFAULT '',
  decision TEXT NOT NULL DEFAULT '',
  observations TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL DEFAULT '',
  lesson TEXT NOT NULL DEFAULT '',
  open_questions_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(open_questions_json)),
  outcome_kind TEXT NOT NULL CHECK (outcome_kind IN ('success','failure','mixed','unknown')),
  event_start TEXT,
  event_end TEXT,
  time_precision TEXT NOT NULL DEFAULT 'unknown'
    CHECK (time_precision IN ('exact','minute','day','month','unknown')),
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  importance REAL NOT NULL CHECK (importance BETWEEN 0 AND 1),
  status TEXT NOT NULL CHECK (status IN ('active','stale','retracted')),
  space TEXT NOT NULL CHECK (space IN ('coding','general','eumenes','personal')),
  scope TEXT NOT NULL CHECK (scope IN ('global','repo')),
  repo_key TEXT,
  facets_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(facets_json)),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (scope = 'repo' OR repo_key IS NULL)
) STRICT;
CREATE INDEX episodes_filter_idx ON episodes(status, space, scope, repo_key);
CREATE TABLE episode_sources (
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES source_records(id),
  locator TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL CHECK (role IN ('derived_from','supports')),
  PRIMARY KEY (episode_id, source_id, locator)
) STRICT;
CREATE INDEX episode_sources_source_idx ON episode_sources(source_id);
CREATE VIRTUAL TABLE episodes_fts USING fts5(
  title, situation, action, outcome, lesson,
  content='episodes', content_rowid='seq', tokenize='trigram'
);
CREATE TRIGGER episodes_fts_ai AFTER INSERT ON episodes BEGIN
  INSERT INTO episodes_fts(rowid, title, situation, action, outcome, lesson)
  VALUES (new.seq, new.title, new.situation, new.action, new.outcome, new.lesson);
END;
CREATE TRIGGER episodes_fts_ad AFTER DELETE ON episodes BEGIN
  INSERT INTO episodes_fts(episodes_fts, rowid, title, situation, action, outcome, lesson)
  VALUES ('delete', old.seq, old.title, old.situation, old.action, old.outcome, old.lesson);
END;
CREATE TRIGGER episodes_fts_au AFTER UPDATE OF title, situation, action, outcome, lesson ON episodes BEGIN
  INSERT INTO episodes_fts(episodes_fts, rowid, title, situation, action, outcome, lesson)
  VALUES ('delete', old.seq, old.title, old.situation, old.action, old.outcome, old.lesson);
  INSERT INTO episodes_fts(rowid, title, situation, action, outcome, lesson)
  VALUES (new.seq, new.title, new.situation, new.action, new.outcome, new.lesson);
END;
`,
	},
];
