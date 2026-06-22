CREATE TABLE IF NOT EXISTS vibe_memories (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  content TEXT NOT NULL,
  memory_type TEXT NOT NULL DEFAULT 'chat',
  dedupe_key TEXT,
  embedding TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  goal_id TEXT,
  parent_id TEXT,
  subject TEXT,
  intent TEXT,
  wants TEXT NOT NULL DEFAULT '[]',
  refs TEXT NOT NULL DEFAULT '[]',
  confidence TEXT,
  evidence_status TEXT,
  actor_id TEXT,
  ttl_at TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS vibe_memories_session_id_idx ON vibe_memories(session_id);
CREATE UNIQUE INDEX IF NOT EXISTS vibe_memories_session_dedupe_key_idx
  ON vibe_memories(session_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE VIRTUAL TABLE IF NOT EXISTS vibe_memories_fts USING fts5(
  id UNINDEXED,
  content
);

CREATE TABLE IF NOT EXISTS agent_diff_entries (
  id TEXT PRIMARY KEY,
  vibe_memory_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  diff_hunk TEXT NOT NULL,
  change_type TEXT,
  language TEXT,
  symbol_name TEXT,
  symbol_kind TEXT,
  signature TEXT,
  start_line INTEGER,
  end_line INTEGER,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (vibe_memory_id) REFERENCES vibe_memories(id) ON DELETE CASCADE
) STRICT;

CREATE VIRTUAL TABLE IF NOT EXISTS agent_diff_entries_fts USING fts5(
  id UNINDEXED,
  vibe_memory_id UNINDEXED,
  file_path,
  diff_hunk,
  symbol_name,
  symbol_kind,
  signature
);

CREATE TABLE IF NOT EXISTS sync_states (
  id TEXT PRIMARY KEY,
  last_synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cursor TEXT NOT NULL DEFAULT '{}',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE IF NOT EXISTS finding_candidate_queue (
  id TEXT PRIMARY KEY,
  input_kind TEXT NOT NULL DEFAULT 'source_target',
  source_kind TEXT NOT NULL DEFAULT 'knowledge_candidate',
  source_key TEXT NOT NULL DEFAULT '',
  source_uri TEXT NOT NULL DEFAULT '',
  distillation_version TEXT NOT NULL DEFAULT 'v1',
  status TEXT NOT NULL DEFAULT 'pending',
  priority INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL DEFAULT '{}',
  metadata TEXT NOT NULL DEFAULT '{}',
  provider_policy TEXT,
  locked_by TEXT,
  locked_at TEXT,
  heartbeat_at TEXT,
  next_run_at TEXT,
  completed_at TEXT,
  last_error TEXT,
  last_outcome_kind TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE IF NOT EXISTS episode_distiller_queue (
  id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL DEFAULT 'vibe_memory',
  source_key TEXT NOT NULL,
  source_uri TEXT NOT NULL,
  distillation_version TEXT NOT NULL DEFAULT 'v1',
  status TEXT NOT NULL DEFAULT 'pending',
  priority INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 2,
  payload TEXT NOT NULL DEFAULT '{}',
  metadata TEXT NOT NULL DEFAULT '{}',
  provider_policy TEXT,
  locked_by TEXT,
  locked_at TEXT,
  heartbeat_at TEXT,
  next_run_at TEXT,
  completed_at TEXT,
  last_error TEXT,
  last_outcome_kind TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS episode_distiller_queue_unique_idx
  ON episode_distiller_queue(source_kind, source_key, distillation_version);

CREATE TABLE IF NOT EXISTS distillation_queue_events (
  id TEXT PRIMARY KEY,
  queue_name TEXT NOT NULL,
  queue_job_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  message TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;
