export function createSqliteCoreSchemaSql(input: { vectorDimension: number }): string {
  const dimension = Math.max(1, Math.trunc(input.vectorDimension));
  return `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS knowledge_items (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'repo',
  polarity TEXT NOT NULL DEFAULT 'positive',
  intent_tags TEXT NOT NULL DEFAULT '[]',
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  applies_to TEXT NOT NULL DEFAULT '{}',
  confidence REAL NOT NULL DEFAULT 70,
  importance REAL NOT NULL DEFAULT 70,
  compile_select_count INTEGER NOT NULL DEFAULT 0,
  last_compiled_at TEXT,
  agentic_accept_count INTEGER NOT NULL DEFAULT 0,
  explicit_upvote_count INTEGER NOT NULL DEFAULT 0,
  explicit_downvote_count INTEGER NOT NULL DEFAULT 0,
  dynamic_score REAL NOT NULL DEFAULT 0,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_verified_at TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS knowledge_items_status_idx ON knowledge_items(status);
CREATE INDEX IF NOT EXISTS knowledge_items_type_status_idx ON knowledge_items(type, status);
CREATE INDEX IF NOT EXISTS knowledge_items_polarity_idx ON knowledge_items(polarity);
CREATE INDEX IF NOT EXISTS knowledge_items_dynamic_score_idx ON knowledge_items(dynamic_score);
CREATE INDEX IF NOT EXISTS knowledge_items_last_compiled_at_idx ON knowledge_items(last_compiled_at);

CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_items_fts USING fts5(
  id UNINDEXED,
  title,
  body
);

CREATE TABLE IF NOT EXISTS knowledge_tag_definitions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  slug TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT,
  aliases TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  sort_order INTEGER NOT NULL DEFAULT 1000,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(kind, slug)
) STRICT;

CREATE TABLE IF NOT EXISTS knowledge_community_labels (
  community_key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  note TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE IF NOT EXISTS knowledge_quality_adjustments (
  id TEXT PRIMARY KEY,
  knowledge_id TEXT NOT NULL,
  adjustment_kind TEXT NOT NULL,
  window_start_at TEXT NOT NULL,
  window_end_at TEXT NOT NULL,
  negative_run_count INTEGER NOT NULL,
  off_topic_rate REAL NOT NULL,
  importance_delta REAL NOT NULL,
  confidence_delta REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (knowledge_id) REFERENCES knowledge_items(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS knowledge_origin_links (
  id TEXT PRIMARY KEY,
  knowledge_id TEXT NOT NULL,
  origin_kind TEXT NOT NULL,
  origin_uri TEXT NOT NULL,
  origin_key TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (knowledge_id) REFERENCES knowledge_items(id) ON DELETE CASCADE,
  UNIQUE(knowledge_id, origin_kind, origin_uri)
) STRICT;

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL,
  uri TEXT NOT NULL UNIQUE,
  title TEXT,
  body TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_indexed_at TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS sources_kind_idx ON sources(source_kind);

CREATE VIRTUAL TABLE IF NOT EXISTS sources_fts USING fts5(
  id UNINDEXED,
  title,
  uri,
  body
);

CREATE TABLE IF NOT EXISTS source_fragments (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  locator TEXT NOT NULL,
  heading TEXT,
  content TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE,
  UNIQUE(source_id, locator)
) STRICT;

CREATE INDEX IF NOT EXISTS source_fragments_source_id_idx ON source_fragments(source_id);

CREATE VIRTUAL TABLE IF NOT EXISTS source_fragments_fts USING fts5(
  id UNINDEXED,
  heading,
  content
);

CREATE TABLE IF NOT EXISTS knowledge_source_links (
  id TEXT PRIMARY KEY,
  knowledge_id TEXT NOT NULL,
  source_fragment_id TEXT NOT NULL,
  link_type TEXT NOT NULL DEFAULT 'derived_from',
  confidence REAL NOT NULL DEFAULT 0.5,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (knowledge_id) REFERENCES knowledge_items(id) ON DELETE CASCADE,
  FOREIGN KEY (source_fragment_id) REFERENCES source_fragments(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS knowledge_source_links_knowledge_idx
  ON knowledge_source_links(knowledge_id);
CREATE INDEX IF NOT EXISTS knowledge_source_links_source_fragment_idx
  ON knowledge_source_links(source_fragment_id);

CREATE TABLE IF NOT EXISTS core_vector_metadata (
  name TEXT PRIMARY KEY,
  dimension INTEGER NOT NULL,
  provider TEXT,
  model TEXT,
  rebuilt_at TEXT,
  row_count INTEGER NOT NULL DEFAULT 0,
  uses_sqlite_vec INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE IF NOT EXISTS knowledge_items_vec_map (
  vec_rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  knowledge_id TEXT NOT NULL UNIQUE,
  FOREIGN KEY (knowledge_id) REFERENCES knowledge_items(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS knowledge_items_vec_fallback (
  knowledge_id TEXT PRIMARY KEY,
  embedding_json TEXT NOT NULL,
  embedding_dimension INTEGER NOT NULL DEFAULT ${dimension},
  content_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (knowledge_id) REFERENCES knowledge_items(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS source_fragments_vec_map (
  vec_rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  source_fragment_id TEXT NOT NULL UNIQUE,
  FOREIGN KEY (source_fragment_id) REFERENCES source_fragments(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS source_fragments_vec_fallback (
  source_fragment_id TEXT PRIMARY KEY,
  embedding_json TEXT NOT NULL,
  embedding_dimension INTEGER NOT NULL DEFAULT ${dimension},
  content_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (source_fragment_id) REFERENCES source_fragments(id) ON DELETE CASCADE
) STRICT;
`;
}
