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
CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL);
INSERT INTO schema_migrations VALUES(10,'larm_request_capacity_v1');
PRAGMA user_version=1;
INSERT INTO finding_candidate_queue(id,source_kind,source_key,source_uri) VALUES('legacy-source','vibe_memory','source','vibe://source');
