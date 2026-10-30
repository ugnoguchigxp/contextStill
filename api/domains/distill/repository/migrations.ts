import type { Migration } from "../../../infrastructure/sqlite";

export const migrations: readonly Migration[] = [
	{
		id: "distill/0001-init",
		after: [
			"knowledge/0002-canonical",
			"experience/0002-retrieval",
			"map/0001-init",
		],
		sql: `
CREATE TABLE distill_assessments (
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('knowledge','episode')),
  owner_id TEXT NOT NULL,
  generality TEXT NOT NULL CHECK (generality IN ('general','generalizable','repo_specific','unusable')),
  signals_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(signals_json)),
  reason TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL CHECK (origin IN ('deterministic','llm','human')),
  content_digest TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  call_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_kind, owner_id)
) STRICT;
CREATE TABLE distill_params (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE distill_runs (
  id TEXT PRIMARY KEY,
  stage TEXT NOT NULL,
  params_json TEXT NOT NULL CHECK (json_valid(params_json)),
  state TEXT NOT NULL CHECK (state IN ('running','completed','failed','cancelled')),
  counts_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(counts_json)),
  started_at TEXT NOT NULL,
  finished_at TEXT
) STRICT;
CREATE TABLE distill_llm_calls (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES distill_runs(id),
  stage TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  latency_ms INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('ok','invalid_output','provider_error')),
  response_json TEXT CHECK (response_json IS NULL OR json_valid(response_json)),
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX distill_llm_calls_digest_idx ON distill_llm_calls(input_digest, outcome);
CREATE INDEX distill_llm_calls_outcome_idx ON distill_llm_calls(outcome, created_at);
CREATE TABLE distill_pair_judgments (
  a_id TEXT NOT NULL,
  b_id TEXT NOT NULL,
  a_digest TEXT NOT NULL,
  b_digest TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN
    ('duplicate','compatible','condition_split','conflict','unrelated','unknown')),
  resolution TEXT NOT NULL CHECK (resolution IN
    ('none','merged','split','a_wins','b_wins','owner_pending','owner_resolved')),
  detail_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail_json)),
  call_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (a_id, b_id)
) STRICT;
CREATE TABLE distill_reviews (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN
    ('conflict','low_confidence','generality','verifier_unknown','host_rejected')),
  subject_json TEXT NOT NULL CHECK (json_valid(subject_json)),
  proposal_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(proposal_json)),
  state TEXT NOT NULL CHECK (state IN ('open','resolved','dismissed')),
  resolution_json TEXT CHECK (resolution_json IS NULL OR json_valid(resolution_json)),
  created_at TEXT NOT NULL,
  resolved_at TEXT
) STRICT;
CREATE INDEX distill_reviews_state_idx ON distill_reviews(state, kind);
`,
	},
];
