import type { Migration } from "../../../infrastructure/sqlite";

export const migrations: readonly Migration[] = [
	{
		id: "map/0001-init",
		after: [],
		sql: `
CREATE TABLE map_clusters (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('claim','theme')),
  parent_id TEXT REFERENCES map_clusters(id),
  level INTEGER NOT NULL DEFAULT 0 CHECK (level BETWEEN 0 AND 2),
  handle TEXT UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  aliases_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(aliases_json)),
  description TEXT NOT NULL DEFAULT '',
  summary_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(summary_json)),
  state TEXT NOT NULL CHECK (state IN ('pending','distilled','review','rejected','stale')),
  member_digest TEXT NOT NULL,
  algorithm TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((kind = 'theme') = (handle IS NOT NULL))
) STRICT;
CREATE INDEX map_clusters_kind_state_idx ON map_clusters(kind, state);
CREATE TABLE map_cluster_members (
  cluster_id TEXT NOT NULL REFERENCES map_clusters(id) ON DELETE CASCADE,
  member_kind TEXT NOT NULL CHECK (member_kind IN ('knowledge','episode')),
  member_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('member','core','example')),
  similarity REAL,
  PRIMARY KEY (cluster_id, member_kind, member_id)
) STRICT;
CREATE INDEX map_cluster_members_member_idx ON map_cluster_members(member_kind, member_id);
CREATE TABLE map_edges (
  id TEXT PRIMARY KEY,
  src_kind TEXT NOT NULL CHECK (src_kind IN ('knowledge','episode','theme')),
  src_id TEXT NOT NULL,
  relation TEXT NOT NULL CHECK (relation IN
    ('about','broader','requires','supports','refines','contradicts','supersedes','example_of','co_used')),
  dst_kind TEXT NOT NULL CHECK (dst_kind IN ('knowledge','episode','theme')),
  dst_id TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('deterministic','clustering','llm','behavioral','human')),
  status TEXT NOT NULL CHECK (status IN ('candidate','active','retracted')),
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  evidence_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(evidence_json)),
  extractor_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (src_kind, src_id, relation, dst_kind, dst_id)
) STRICT;
CREATE INDEX map_edges_src_idx ON map_edges(src_kind, src_id, relation, status);
CREATE INDEX map_edges_dst_idx ON map_edges(dst_kind, dst_id, relation, status);
CREATE TABLE map_facet_concepts (
  facet_key TEXT NOT NULL CHECK (facet_key IN ('domains','technologies','changeTypes')),
  raw_value TEXT NOT NULL,
  concept TEXT NOT NULL,
  theme_id TEXT REFERENCES map_clusters(id),
  origin TEXT NOT NULL CHECK (origin IN ('deterministic','llm','human')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (facet_key, raw_value)
) STRICT;
`,
	},
];
