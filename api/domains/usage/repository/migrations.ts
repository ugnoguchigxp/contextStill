import type { Migration } from "../../../infrastructure/sqlite";

export const migrations: readonly Migration[] = [
	{
		id: "usage/0001-init",
		after: [],
		sql: `
CREATE TABLE usage_events (
  id TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('knowledge','episode')),
  owner_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('compile','search','mcp')),
  verdict TEXT NOT NULL CHECK (verdict IN ('presented','used','not_used','wrong','off_topic')),
  actor TEXT NOT NULL CHECK (actor IN ('agent','system','user','eumenes')),
  run_ref TEXT,
  reason TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('legacy_import','live')),
  occurred_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json))
) STRICT;
CREATE INDEX usage_events_owner_idx ON usage_events(owner_kind, owner_id, verdict);
CREATE INDEX usage_events_run_idx ON usage_events(run_ref);
`,
	},
];
