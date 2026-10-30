import type { Database } from "bun:sqlite";
import { listSupersededBy } from "../../../knowledge";

/**
 * Read-only listings of other domains' rows that the theme and examples stages need and that
 * those domains do not export as a list. Nothing here writes; every write of these stages goes
 * through the owning domain's `index.ts`. (N2-F report: move these into knowledge / experience
 * when convenient.)
 */

export interface CanonicalRef {
	id: string;
	contentDigest: string;
}

/** Active canonical items, by id. Canonicals of the `personal` space are not themed. */
export function listActiveCanonicals(db: Database): CanonicalRef[] {
	return (
		db
			.query(
				`SELECT id, content_digest FROM knowledge_items
				 WHERE layer = 'canonical' AND status = 'active' AND space <> 'personal'
				 ORDER BY id`,
			)
			.all() as { id: string; content_digest: string }[]
	).map((r) => ({ id: r.id, contentDigest: r.content_digest }));
}

/** Every repo key of knowledge and episodes (the input of `buildRepoTerms`). */
export function listRepoKeys(db: Database): string[] {
	return (
		db
			.query(
				`SELECT repo_key FROM knowledge_items WHERE repo_key IS NOT NULL
				 UNION SELECT repo_key FROM episodes WHERE repo_key IS NOT NULL`,
			)
			.all() as { repo_key: string }[]
	).map((r) => r.repo_key);
}

export const FACET_KEYS = ["domains", "technologies", "changeTypes"] as const;
export type FacetKeyName = (typeof FACET_KEYS)[number];

export const normalizeFacetValue = (value: string): string =>
	value.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * For every (facet key, normalised value) of the atoms: the active canonical each atom with that
 * value was absorbed into, once per atom (an atom that was not absorbed adds nothing, but the
 * value is still listed). Key order of the result is by key, then value.
 */
export function collectFacetEvidence(
	db: Database,
): Map<FacetKeyName, Map<string, string[]>> {
	const out = new Map<FacetKeyName, Map<string, string[]>>(
		FACET_KEYS.map((key) => [key, new Map()]),
	);
	const atoms = db
		.query(
			"SELECT id, facets_json FROM knowledge_items WHERE layer = 'atom' AND space <> 'personal' ORDER BY id",
		)
		.all() as { id: string; facets_json: string }[];
	const active = new Set(
		(
			db
				.query(
					"SELECT id FROM knowledge_items WHERE layer = 'canonical' AND status = 'active' AND space <> 'personal'",
				)
				.all() as { id: string }[]
		).map((r) => r.id),
	);
	for (const atom of atoms) {
		let facets: Record<string, unknown>;
		try {
			facets = JSON.parse(atom.facets_json) as Record<string, unknown>;
		} catch {
			continue;
		}
		let absorbedBy: string | null | undefined;
		for (const key of FACET_KEYS) {
			const raw = facets[key];
			if (!Array.isArray(raw)) continue;
			const values = new Set(
				raw
					.filter((v): v is string => typeof v === "string")
					.map(normalizeFacetValue)
					.filter((v) => v.length > 0),
			);
			for (const value of values) {
				const byValue = out.get(key)!;
				let list = byValue.get(value);
				if (!list) byValue.set(value, (list = []));
				if (absorbedBy === undefined)
					absorbedBy =
						listSupersededBy(db, atom.id).find((id) => active.has(id)) ?? null;
				if (absorbedBy !== null) list.push(absorbedBy);
			}
		}
	}
	for (const [key, byValue] of out)
		out.set(
			key,
			new Map([...byValue].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
		);
	return out;
}

/**
 * The episodes the examples stage may show in a canonical: the same ones search returns to every
 * caller (`global`, not `personal`, `searchable`, `active`). Anything else (a repo's, a person's or
 * an evidence-only record) never reaches a prompt or a canonical's examples.
 */
const EXAMPLE_EPISODE =
	"e.scope = 'global' AND e.space <> 'personal' AND e.retrieval = 'searchable' AND e.status = 'active'";

/** The same rule for a row already read (a direct evidence link of a canonical). */
export const isExampleEpisode = (e: {
	scope: string;
	space: string;
	retrieval: string;
	status: string;
}): boolean =>
	e.scope === "global" &&
	e.space !== "personal" &&
	e.retrieval === "searchable" &&
	e.status === "active";

/** Ids of the episodes that may be examples, by id. */
export function listActiveEpisodeIds(db: Database): string[] {
	return (
		db
			.query(
				`SELECT e.id FROM episodes e WHERE ${EXAMPLE_EPISODE} ORDER BY e.id`,
			)
			.all() as { id: string }[]
	).map((r) => r.id);
}

/** Episodes that may be examples and have any of the sources as an original record, by id. */
export function episodesOfSources(
	db: Database,
	sourceIds: readonly string[],
): string[] {
	const found = new Set<string>();
	const unique = [...new Set(sourceIds)];
	for (let i = 0; i < unique.length; i += 400) {
		const chunk = unique.slice(i, i + 400);
		const rows = db
			.query(
				`SELECT DISTINCT s.episode_id AS id FROM episode_sources s
				 JOIN episodes e ON e.id = s.episode_id
				 WHERE ${EXAMPLE_EPISODE} AND s.source_id IN (${chunk.map(() => "?").join(",")})`,
			)
			.all(...chunk) as { id: string }[];
		for (const r of rows) found.add(r.id);
	}
	return [...found].sort();
}
