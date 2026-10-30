import { Database } from "bun:sqlite";
import { sha256Hex } from "../../../infrastructure/digest";

/**
 * A miniature of the legacy snapshot: the 12 tables as `.schema` printed them (the two
 * triggers that read `settings` are left out), filled with a few rows per import rule.
 */
export const LEGACY_SCHEMA = `
CREATE TABLE vibe_memories (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, content TEXT NOT NULL,
  memory_type TEXT NOT NULL DEFAULT 'chat', dedupe_key TEXT, embedding TEXT,
  metadata TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  goal_id TEXT, parent_id TEXT, subject TEXT, intent TEXT, wants TEXT NOT NULL DEFAULT '[]',
  refs TEXT NOT NULL DEFAULT '[]', confidence TEXT, evidence_status TEXT, actor_id TEXT, ttl_at TEXT
) STRICT;
CREATE TABLE sources (
  id TEXT PRIMARY KEY, source_kind TEXT NOT NULL, uri TEXT NOT NULL UNIQUE, title TEXT,
  body TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, last_indexed_at TEXT,
  classification_status TEXT NOT NULL DEFAULT 'unresolved', scope TEXT NOT NULL DEFAULT 'repo',
  project_ref TEXT, repo_key TEXT, repo_path TEXT
) STRICT;
CREATE TABLE source_fragments (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL, locator TEXT NOT NULL, heading TEXT,
  content TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE, UNIQUE(source_id, locator)
) STRICT;
CREATE TABLE episode_cards (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, situation TEXT NOT NULL,
  observations TEXT NOT NULL DEFAULT '', action TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL DEFAULT '', lesson TEXT NOT NULL DEFAULT '',
  applicability TEXT NOT NULL DEFAULT '{}', anti_applicability TEXT NOT NULL DEFAULT '{}',
  domains TEXT NOT NULL DEFAULT '[]', technologies TEXT NOT NULL DEFAULT '[]',
  change_types TEXT NOT NULL DEFAULT '[]', tools TEXT NOT NULL DEFAULT '[]',
  repo_path TEXT, repo_key TEXT, source_kind TEXT NOT NULL, source_key TEXT NOT NULL,
  outcome_kind TEXT NOT NULL DEFAULT 'unknown', confidence INTEGER NOT NULL DEFAULT 50,
  status TEXT NOT NULL DEFAULT 'active', stale_at TEXT, embedding TEXT,
  metadata TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, importance INTEGER NOT NULL DEFAULT 50,
  compile_use_count INTEGER NOT NULL DEFAULT 0, decision_use_count INTEGER NOT NULL DEFAULT 0,
  classification_status TEXT NOT NULL DEFAULT 'unresolved', scope TEXT NOT NULL DEFAULT 'repo',
  project_ref TEXT
) STRICT;
CREATE UNIQUE INDEX episode_cards_source_unique_idx ON episode_cards(source_kind, source_key);
CREATE TABLE episode_refs (
  id TEXT PRIMARY KEY, episode_card_id TEXT NOT NULL, ref_kind TEXT NOT NULL,
  ref_value TEXT NOT NULL, locator TEXT, query_hint TEXT, metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (episode_card_id) REFERENCES episode_cards(id) ON DELETE CASCADE
) STRICT;
CREATE TABLE knowledge_items (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'repo', polarity TEXT NOT NULL DEFAULT 'positive',
  intent_tags TEXT NOT NULL DEFAULT '[]', title TEXT NOT NULL, body TEXT NOT NULL,
  applies_to TEXT NOT NULL DEFAULT '{}', confidence REAL NOT NULL DEFAULT 70,
  importance REAL NOT NULL DEFAULT 70, compile_select_count INTEGER NOT NULL DEFAULT 0,
  last_compiled_at TEXT, agentic_accept_count INTEGER NOT NULL DEFAULT 0,
  explicit_upvote_count INTEGER NOT NULL DEFAULT 0, explicit_downvote_count INTEGER NOT NULL DEFAULT 0,
  dynamic_score REAL NOT NULL DEFAULT 0, metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, last_verified_at TEXT,
  classification_status TEXT NOT NULL DEFAULT 'unresolved', project_ref TEXT, repo_key TEXT,
  repo_path TEXT
) STRICT;
CREATE TABLE knowledge_usage_events (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, knowledge_id TEXT NOT NULL, verdict TEXT NOT NULL,
  actor TEXT NOT NULL, reason TEXT, metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;
CREATE TABLE knowledge_items_vec_fallback (
  knowledge_id TEXT PRIMARY KEY, embedding_json TEXT NOT NULL,
  embedding_dimension INTEGER NOT NULL DEFAULT 384, content_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (knowledge_id) REFERENCES knowledge_items(id) ON DELETE CASCADE
) STRICT;
CREATE TABLE found_candidates (
  id TEXT PRIMARY KEY, finding_job_id TEXT NOT NULL, candidate_index INTEGER NOT NULL,
  type TEXT, title TEXT NOT NULL, content TEXT NOT NULL, source_summary TEXT,
  origin TEXT NOT NULL DEFAULT '{}', metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;
CREATE TABLE finding_candidate_queue (
  id TEXT PRIMARY KEY, input_kind TEXT NOT NULL DEFAULT 'source_target',
  source_kind TEXT NOT NULL DEFAULT 'knowledge_candidate', source_key TEXT NOT NULL DEFAULT '',
  source_uri TEXT NOT NULL DEFAULT '', distillation_version TEXT NOT NULL DEFAULT 'v1',
  status TEXT NOT NULL DEFAULT 'pending', priority INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL DEFAULT '{}',
  metadata TEXT NOT NULL DEFAULT '{}', provider_policy TEXT, locked_by TEXT, locked_at TEXT,
  heartbeat_at TEXT, next_run_at TEXT, completed_at TEXT, last_error TEXT, last_outcome_kind TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  input_generation INTEGER NOT NULL DEFAULT 0, protocol_version INTEGER NOT NULL DEFAULT 1
) STRICT;
CREATE TABLE knowledge_source_links (
  id TEXT PRIMARY KEY, knowledge_id TEXT NOT NULL, source_fragment_id TEXT NOT NULL,
  link_type TEXT NOT NULL DEFAULT 'derived_from', confidence REAL NOT NULL DEFAULT 0.5,
  metadata TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (knowledge_id) REFERENCES knowledge_items(id) ON DELETE CASCADE,
  FOREIGN KEY (source_fragment_id) REFERENCES source_fragments(id) ON DELETE CASCADE
) STRICT;
CREATE TABLE knowledge_origin_links (
  id TEXT PRIMARY KEY, knowledge_id TEXT NOT NULL, origin_kind TEXT NOT NULL,
  origin_uri TEXT NOT NULL, origin_key TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 1.0,
  metadata TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (knowledge_id) REFERENCES knowledge_items(id) ON DELETE CASCADE,
  UNIQUE(knowledge_id, origin_kind, origin_uri)
) STRICT;
`;

type Row = Record<string, string | number | null>;

export function insert(db: Database, table: string, row: Row): void {
	const names = Object.keys(row);
	db.query(
		`INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
	).run(...Object.values(row));
}

/** The vector `[1/sqrt(n), …]`: finite, L2 norm 1. */
export function unitVector(dimension = 384): number[] {
	return Array.from({ length: dimension }, () => 1 / Math.sqrt(dimension));
}
export const contentHash = (title: string, body: string) =>
	sha256Hex(`${title}\n${body}`);

export const ISO = "2026-06-18T14:57:56.032Z";
export const SQLITE_TIME = "2026-09-11 05:04:10";
export const UNIX_MS = "unix-ms:1782131618752";

export function createLegacyDb(path: string): Database {
	const db = new Database(path, { create: true });
	db.exec(LEGACY_SCHEMA);
	return db;
}

const KNOWLEDGE = (id: string, over: Row = {}): Row => ({
	id,
	type: "rule",
	status: "active",
	scope: "repo",
	title: `title ${id}`,
	body: `body ${id}`,
	confidence: 85,
	importance: 70,
	created_at: ISO,
	updated_at: ISO,
	...over,
});
const meta = (value: unknown) => JSON.stringify(value);
const FINALIZE_OK = {
	decision: "stored",
	qualityGates: [
		"importance",
		"candidate_quality",
		"applicability",
		"embedding",
	],
};

/**
 * One row per rule. Knowledge `k1`..`k13` cover the provenance steps, the draft gate and
 * the status/scope mapping; vectors cover unverified / stale / invalid.
 */
export function seedLegacy(db: Database): void {
	// vibe memories: the three timestamp formats
	insert(db, "vibe_memories", {
		id: "v1",
		session_id: "sess-1",
		content: "ASSISTANT: one",
		subject: "first",
		metadata: meta({ cwd: "/repo", n: 1 }),
		created_at: ISO,
	});
	insert(db, "vibe_memories", {
		id: "v2",
		session_id: "sess-1",
		content: "ASSISTANT: two",
		created_at: SQLITE_TIME,
	});
	insert(db, "vibe_memories", {
		id: "v3",
		session_id: "sess-2",
		content: "USER: three",
		memory_type: "capsule",
		created_at: UNIX_MS,
	});

	// wiki sources (document), a web source, and one of an unknown kind (skipped)
	insert(db, "sources", {
		id: "s1",
		source_kind: "wiki",
		uri: "/r/wiki/pages/a.md",
		title: "A",
		body: "page a",
		scope: "repo",
		repo_key: "/users/me/code/r",
		created_at: ISO,
		updated_at: ISO,
	});
	insert(db, "sources", {
		id: "s2",
		source_kind: "wiki",
		uri: "/r/wiki/pages/b.md",
		body: "page b",
		scope: "repo",
		created_at: SQLITE_TIME,
		updated_at: SQLITE_TIME,
	});
	insert(db, "sources", {
		id: "s3",
		source_kind: "web_page",
		uri: "https://example.com/doc",
		body: "web doc",
		scope: "global",
		created_at: ISO,
		updated_at: ISO,
	});
	insert(db, "sources", {
		id: "s4",
		source_kind: "weird",
		uri: "weird://x",
		body: "x",
		created_at: ISO,
		updated_at: ISO,
	});
	insert(db, "source_fragments", {
		id: "f1",
		source_id: "s1",
		locator: "chunk:0001",
		heading: "Intro",
		content: "intro text",
		created_at: ISO,
	});
	insert(db, "source_fragments", {
		id: "f2",
		source_id: "s2",
		locator: "chunk:0001",
		content: "b text",
		created_at: SQLITE_TIME,
	});

	// episodes: active / stale / global / unknown status (skipped)
	const episode = (id: string, over: Row = {}): Row => ({
		id,
		title: `episode ${id}`,
		situation: "situation",
		source_kind: "vibe_memory",
		source_key: id,
		outcome_kind: "success",
		confidence: 80,
		importance: 60,
		domains: '["d"]',
		technologies: '["ts"]',
		change_types: '["bugfix"]',
		tools: "[]",
		applicability: '{"when":"x"}',
		scope: "repo",
		repo_key: "/users/me/code/r",
		created_at: SQLITE_TIME,
		updated_at: SQLITE_TIME,
		...over,
	});
	insert(db, "episode_cards", episode("e1"));
	insert(db, "episode_cards", episode("e2", { stale_at: ISO }));
	insert(db, "episode_cards", episode("e3", { scope: "repo", repo_key: null }));
	insert(db, "episode_cards", episode("e4", { status: "weird" }));
	insert(db, "episode_refs", {
		id: "r1",
		episode_card_id: "e1",
		ref_kind: "vibe_memory",
		ref_value: "v1",
		locator: "bytes:0-10",
		created_at: ISO,
	});
	insert(db, "episode_refs", {
		id: "r2",
		episode_card_id: "e2",
		ref_kind: "vibe_memory",
		ref_value: "v2",
		created_at: ISO,
	});

	// provenance chains: found_candidates -> finding_candidate_queue
	const chain = (n: string, kind: string, key: string, uri: string): Row[] => [
		{ id: `fc-${n}`, finding_job_id: `job-${n}` },
		{ id: `job-${n}`, source_kind: kind, source_key: key, source_uri: uri },
	];
	for (const [n, kind, key, uri] of [
		["1", "vibe_memory", "v1", "vibe_memory:v1"],
		["2", "vibe_memory", "gone", "vibe_memory:gone"],
		["3", "wiki_file", "b.md", "/r/wiki/pages/b.md"],
		["4", "web_ingest", "https://x.test/p", "https://x.test/p"],
		["5", "knowledge_candidate", "cand-5", ""],
		["6", "web_ingest", "https://example.com/doc", "https://example.com/doc"],
	] as const) {
		const [candidate, job] = chain(n, kind, key, uri) as [Row, Row];
		insert(db, "found_candidates", {
			...candidate,
			candidate_index: 0,
			title: "t",
			content: "c",
		});
		insert(db, "finding_candidate_queue", job);
	}

	const withChain = (n: string) => meta({ foundCandidateId: `fc-${n}` });
	insert(
		db,
		"knowledge_items",
		KNOWLEDGE("k1", {
			metadata: withChain("1"),
			dynamic_score: 1.5,
			compile_select_count: 3,
			applies_to: '{"domains":["x"]}',
			intent_tags: '["t"]',
			repo_key: "/users/me/code/r",
		}),
	);
	insert(db, "knowledge_items", KNOWLEDGE("k2", { metadata: withChain("2") }));
	insert(
		db,
		"knowledge_items",
		KNOWLEDGE("k3", {
			metadata: withChain("3"),
			type: "procedure",
			polarity: "negative",
		}),
	);
	insert(db, "knowledge_items", KNOWLEDGE("k4", { metadata: withChain("4") }));
	insert(db, "knowledge_items", KNOWLEDGE("k5", { metadata: withChain("5") }));
	insert(
		db,
		"knowledge_items",
		KNOWLEDGE("k6", {
			metadata: meta({ targetKind: "vibe_memory", targetKey: "v2" }),
		}),
	);
	insert(db, "knowledge_items", KNOWLEDGE("k7", { metadata: "{}" }));
	insert(
		db,
		"knowledge_items",
		KNOWLEDGE("k8", {
			metadata: meta({
				targetKind: "vibe_memory",
				targetKey: "the source target",
			}),
			scope: "global",
		}),
	);
	insert(
		db,
		"knowledge_items",
		KNOWLEDGE("k9", {
			status: "draft",
			metadata: meta({
				finalizeSummary: FINALIZE_OK,
				foundCandidateId: "fc-1",
			}),
			created_at: UNIX_MS,
			updated_at: "garbage",
		}),
	);
	insert(
		db,
		"knowledge_items",
		KNOWLEDGE("k10", {
			status: "draft",
			metadata: meta({
				finalizeSummary: { decision: "stored", qualityGates: ["importance"] },
			}),
		}),
	);
	insert(
		db,
		"knowledge_items",
		KNOWLEDGE("k11", { status: "deprecated", metadata: withChain("1") }),
	);
	insert(
		db,
		"knowledge_items",
		KNOWLEDGE("k12", {
			metadata: withChain("6"),
			repo_key: "/users/me/code/r",
			created_at: "garbage",
			updated_at: SQLITE_TIME,
		}),
	);
	insert(db, "knowledge_items", KNOWLEDGE("k13", { type: "weird" }));
	insert(db, "knowledge_items", KNOWLEDGE("k14", { status: "weird" }));
	insert(db, "knowledge_origin_links", {
		id: "o1",
		knowledge_id: "k7",
		origin_kind: "vibe_memory",
		origin_uri: "vibe_memory:v3",
		origin_key: "v3",
	});
	insert(db, "knowledge_origin_links", {
		id: "o2",
		knowledge_id: "k7",
		origin_kind: "landscape_review_item",
		origin_uri: "review://1",
		origin_key: "1",
	});
	insert(db, "knowledge_source_links", {
		id: "l1",
		knowledge_id: "k12",
		source_fragment_id: "f1",
		confidence: 0.8,
	});

	// usage events
	insert(db, "knowledge_usage_events", {
		id: "u1",
		run_id: "run-1",
		knowledge_id: "k1",
		verdict: "used",
		actor: "agent",
		metadata: meta({ selectedRank: 1 }),
		created_at: UNIX_MS,
	});
	insert(db, "knowledge_usage_events", {
		id: "u2",
		run_id: "run-1",
		knowledge_id: "k2",
		verdict: "not_used",
		actor: "system",
		reason: "later",
		created_at: ISO,
	});
	insert(db, "knowledge_usage_events", {
		id: "u3",
		run_id: "run-2",
		knowledge_id: "k1",
		verdict: "weird",
		actor: "agent",
		created_at: ISO,
	});

	// vectors: fresh, stale (hash differs), invalid norm, invalid length
	const vec = (id: string, over: Row = {}): Row => ({
		knowledge_id: id,
		embedding_json: JSON.stringify(unitVector()),
		embedding_dimension: 384,
		content_hash: contentHash(`title ${id}`, `body ${id}`),
		updated_at: ISO,
		...over,
	});
	insert(db, "knowledge_items_vec_fallback", vec("k1"));
	insert(
		db,
		"knowledge_items_vec_fallback",
		vec("k2", { content_hash: "old-hash" }),
	);
	insert(
		db,
		"knowledge_items_vec_fallback",
		vec("k3", {
			embedding_json: JSON.stringify(unitVector().map((v) => v * 2)),
		}),
	);
	insert(
		db,
		"knowledge_items_vec_fallback",
		vec("k4", { embedding_json: "[0.1, 0.2]", embedding_dimension: 2 }),
	);
}
