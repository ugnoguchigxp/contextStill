export const manualResearchSchemaSql = `
CREATE TABLE IF NOT EXISTS manual_research_runs (
  id TEXT PRIMARY KEY,
  client_request_key TEXT NOT NULL UNIQUE,
  topic TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  plugin_job_id TEXT,
  status TEXT NOT NULL DEFAULT 'created',
  sync_error TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  result_hash TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_synced_at TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS manual_research_runs_status_idx
  ON manual_research_runs(status, updated_at);

CREATE TABLE IF NOT EXISTS manual_research_explorations (
  run_id TEXT PRIMARY KEY REFERENCES manual_research_runs(id),
  engine TEXT NOT NULL CHECK(engine IN ('deepstill','codex')),
  options_json TEXT NOT NULL,
  runtime_owner TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS manual_research_candidate_imports (
  run_id TEXT NOT NULL REFERENCES manual_research_runs(id),
  claim_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  receipt_json TEXT,
  PRIMARY KEY(run_id, claim_id)
) STRICT;
`;
