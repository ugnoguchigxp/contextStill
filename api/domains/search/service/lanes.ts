import type { Database } from "bun:sqlite";
import type { Space } from "../../../infrastructure/scope";
import type { KnowledgeLayer, KnowledgeType } from "../../knowledge";
import type { SearchKind } from "../contracts";

export interface Filter {
	spaces: Space[];
	repoKey: string | null;
	types: KnowledgeType[] | null;
	layers: KnowledgeLayer[];
	/** Evaluation baseline only: status IN ('active','superseded') and retrieval is not looked at. */
	includeSuperseded: boolean;
	/** The theme and its descendants; rows must belong to one of them through an active `about` edge. */
	themeIds: string[] | null;
}
export interface Candidate {
	id: string;
	/** The lane's native score, higher is better (fts: -bm25, short: points, vector: dot). */
	raw: number;
}

/** Collects positional parameters and hands out numbered placeholders (`?3`). */
class Binder {
	readonly values: (string | number)[] = [];
	bind(value: string | number): string {
		this.values.push(value);
		return `?${this.values.length}`;
	}
	list(values: readonly (string | number)[]): string {
		return values.map((value) => this.bind(value)).join(", ");
	}
}

const TABLE: Record<SearchKind, string> = {
	knowledge: "knowledge_items",
	episode: "episodes",
};

/** The scope conditions every lane puts in its WHERE, before ranking and limiting. */
function scopeSql(
	alias: string,
	kind: SearchKind,
	filter: Filter,
	binder: Binder,
): string {
	const parts = [
		filter.includeSuperseded
			? `${alias}.status IN ('active', 'superseded')`
			: `${alias}.status = 'active' AND ${alias}.retrieval = 'searchable'`,
		`${alias}.space IN (${binder.list(filter.spaces)})`,
		filter.repoKey === null
			? `${alias}.scope = 'global'`
			: `(${alias}.scope = 'global' OR (${alias}.scope = 'repo' AND ${alias}.repo_key = ${binder.bind(filter.repoKey)}))`,
	];
	if (kind === "knowledge") {
		parts.push(`${alias}.layer IN (${binder.list(filter.layers)})`);
		if (filter.types)
			parts.push(`${alias}.type IN (${binder.list(filter.types)})`);
	}
	if (filter.themeIds)
		parts.push(
			`EXISTS (SELECT 1 FROM map_edges e WHERE e.src_kind = '${kind}' AND e.src_id = ${alias}.id
				AND e.relation = 'about' AND e.status = 'active' AND e.dst_kind = 'theme'
				AND e.dst_id IN (${binder.list(filter.themeIds)}))`,
		);
	return parts.join(" AND ");
}

/** Columns that score 2 points like the title: a canonical's situation says when it applies. */
const TITLE_LIKE_COLUMNS: Record<SearchKind, string[]> = {
	knowledge: ["title", "situation"],
	episode: ["title"],
};
const BODY_COLUMNS: Record<SearchKind, string[]> = {
	knowledge: ["body"],
	episode: ["situation", "action", "outcome", "lesson"],
};

export function runLexicalLane(
	db: Database,
	kind: SearchKind,
	lane: "fts" | "short",
	terms: string[],
	filter: Filter,
	limit: number,
): Candidate[] {
	const binder = new Binder();
	const table = TABLE[kind];
	if (lane === "fts") {
		const fts = kind === "knowledge" ? "knowledge_fts" : "episodes_fts";
		// knowledge_fts: title, situation, body. episodes_fts: title, situation, action, outcome, lesson.
		const weights =
			kind === "knowledge" ? "2.0, 2.5, 1.0" : "2.0, 1.0, 1.0, 1.0, 1.5";
		const match = binder.bind(
			terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR "),
		);
		const where = scopeSql("t", kind, filter, binder);
		const sql = `SELECT t.id AS id, bm25(${fts}, ${weights}) AS score
			FROM ${fts} JOIN ${table} t ON t.seq = ${fts}.rowid
			WHERE ${fts} MATCH ${match} AND ${where}
			ORDER BY score ASC, t.seq ASC LIMIT ${limit}`;
		const rows = db.query(sql).all(...binder.values) as {
			id: string;
			score: number;
		}[];
		return rows.map((row) => ({ id: row.id, raw: -row.score }));
	}
	// Per term: 2 points for a title hit, 2 for a situation hit (knowledge), 1 for a body hit; `hits` counts the terms that
	// appear anywhere. A row needs hits on at least half of the terms, so a single noisy
	// term cannot pull unrelated rows into the lane when the query has many terms.
	const perTerm = terms.map((term) => {
		const placeholder = binder.bind(term);
		const body = BODY_COLUMNS[kind]
			.map((column) => `instr(lower(t.${column}), ${placeholder}) > 0`)
			.join(" OR ");
		const titleLike = TITLE_LIKE_COLUMNS[kind].map(
			(column) => `(instr(lower(t.${column}), ${placeholder}) > 0)`,
		);
		const title = titleLike.join(" OR ");
		return {
			points: `${titleLike.map((hit) => `${hit} * 2`).join(" + ")} + ((${body}) > 0)`,
			hit: `((${title}) OR (${body}))`,
		};
	});
	const points = perTerm.map((term) => term.points).join(" + ");
	const hits = perTerm.map((term) => `(${term.hit})`).join(" + ");
	const minHits = Math.max(1, Math.ceil(terms.length / 2));
	const where = scopeSql("t", kind, filter, binder);
	const sql = `SELECT id, points FROM (
			SELECT t.id AS id, t.seq AS seq, ${points} AS points, ${hits} AS hits
			FROM ${table} t WHERE ${where}
		) WHERE points > 0 AND hits >= ${minHits} ORDER BY points DESC, hits DESC, seq ASC LIMIT ${limit}`;
	const rows = db.query(sql).all(...binder.values) as {
		id: string;
		points: number;
	}[];
	return rows.map((row) => ({ id: row.id, raw: row.points }));
}

/**
 * Vectors in scope that may be used, streamed so the whole space is never held in memory.
 * Usable means: LARM-made or verified, not marked `mismatch`/`stale`, and (for knowledge,
 * whose table carries `content_digest`) made from the text as it is now. `countUnverified`
 * counts the in-scope vectors only held back for being unverified legacy imports; call it
 * only when nothing was usable.
 */
export function runVectorRows(
	db: Database,
	kind: SearchKind,
	spaceKey: string,
	filter: Filter,
): {
	rows: Iterable<{ ownerId: string; vector: Uint8Array }>;
	countUnverified: () => number;
} {
	const build = (extra: string) => {
		const binder = new Binder();
		const space = binder.bind(spaceKey);
		const where = scopeSql("t", kind, filter, binder);
		// Only knowledge_items has content_digest; episodes are covered by verification alone.
		const fresh =
			kind === "knowledge" ? "v.content_digest = t.content_digest" : "1";
		const sql = `SELECT v.owner_id AS ownerId, v.vector AS vector FROM vectors v
			JOIN ${TABLE[kind]} t ON t.id = v.owner_id
			WHERE v.owner_kind = '${kind}' AND v.space_key = ${space} AND ${fresh} AND ${extra} AND ${where}`;
		return { sql, values: binder.values };
	};
	const usable = build(
		"(v.origin = 'larm' OR v.verification = 'verified') AND v.verification NOT IN ('mismatch', 'stale')",
	);
	const rows = db
		.query(usable.sql)
		.iterate(...usable.values) as IterableIterator<{
		ownerId: string;
		vector: Uint8Array;
	}>;
	const countUnverified = () => {
		const held = build("v.origin <> 'larm' AND v.verification = 'unverified'");
		return (
			db
				.query(`SELECT count(*) AS n FROM (${held.sql})`)
				.get(...held.values) as {
				n: number;
			}
		).n;
	};
	return { rows, countUnverified };
}
