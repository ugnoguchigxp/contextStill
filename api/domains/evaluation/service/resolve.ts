import type { Database } from "bun:sqlite";
import type { EvalCase } from "../contracts";
import { edgesTo } from "../../map";

/** `kind:id`, the key a search hit and a grade map share. */
export const keyOf = (kind: string, id: string) => `${kind}:${id}`;

/** A canonical replaced by another canonical is followed at most this many times (plan 8.1). */
const MAX_CANONICAL_HOPS = 3;
/** atom -> canonical is one hop, then up to MAX_CANONICAL_HOPS canonical -> canonical hops. */
const MAX_HOPS = 1 + MAX_CANONICAL_HOPS;

interface RowFacts {
	status: string;
	scope: string;
	layer: string | null;
	space: string;
	retrieval: string;
}

function rowFacts(
	db: Database,
	kind: "knowledge" | "episode",
	id: string,
): RowFacts | null {
	return kind === "knowledge"
		? db
				.query<RowFacts, [string]>(
					"SELECT status, scope, layer, space, retrieval FROM knowledge_items WHERE id = ?",
				)
				.get(id)
		: db
				.query<RowFacts, [string]>(
					"SELECT status, scope, NULL AS layer, space, retrieval FROM episodes WHERE id = ?",
				)
				.get(id);
}

const inCase = (
	evalCase: EvalCase,
	kind: "knowledge" | "episode",
	facts: RowFacts,
) =>
	evalCase.kinds.includes(kind) &&
	facts.scope === "global" &&
	(evalCase.spaces as readonly string[]).includes(facts.space);

/**
 * Rows the default `v2-hybrid` search can return for a case without a repoKey:
 * active, searchable, global scope, the case's space and kind, atom or canonical.
 */
function hybridReachable(
	evalCase: EvalCase,
	kind: "knowledge" | "episode",
	facts: RowFacts,
): boolean {
	return (
		inCase(evalCase, kind, facts) &&
		facts.status === "active" &&
		facts.retrieval === "searchable"
	);
}

/**
 * Rows the atoms before distillation offered (`v2-atom-baseline`, and the legacy systems):
 * active or superseded atoms, retrieval ignored.
 */
function baselineReachable(
	evalCase: EvalCase,
	kind: "knowledge" | "episode",
	facts: RowFacts,
): boolean {
	return (
		inCase(evalCase, kind, facts) &&
		(kind === "episode"
			? facts.status === "active"
			: facts.layer === "atom" &&
				(facts.status === "active" || facts.status === "superseded"))
	);
}

/**
 * The knowledge rows `supersedes` leads to from `id`, replacing a row that search no longer
 * returns (superseded, retracted, evidence_only) with the active searchable canonical that
 * replaced it: atom -> canonical, then canonical -> canonical up to three more times. A row
 * search returns stands for itself. Several paths give several rows.
 */
export function currentTargets(
	db: Database,
	evalCase: EvalCase,
	id: string,
): string[] {
	const found = new Set<string>();
	const seen = new Set<string>([id]);
	let frontier = [id];
	for (let hop = 0; hop <= MAX_HOPS && frontier.length > 0; hop++) {
		const next: string[] = [];
		for (const current of frontier) {
			const facts = rowFacts(db, "knowledge", current);
			if (!facts) continue;
			if (hybridReachable(evalCase, "knowledge", facts)) {
				found.add(current);
				continue;
			}
			if (hop === MAX_HOPS) continue;
			for (const edge of edgesTo(db, "knowledge", current, "supersedes")) {
				if (
					edge.status !== "active" ||
					edge.src.kind !== "knowledge" ||
					seen.has(edge.src.id)
				)
					continue;
				seen.add(edge.src.id);
				next.push(edge.src.id);
			}
		}
		frontier = next;
	}
	return [...found];
}

/**
 * The canonicals (and the row itself) that stand for the same claim as knowledge row `id`:
 * the row, plus every active `supersedes` source reached from it, up to `MAX_HOPS` hops.
 */
export function claimSet(db: Database, id: string): Set<string> {
	const out = new Set<string>([id]);
	let frontier = [id];
	for (let hop = 0; hop < MAX_HOPS && frontier.length > 0; hop++) {
		const next: string[] = [];
		for (const current of frontier)
			for (const edge of edgesTo(db, "knowledge", current, "supersedes")) {
				if (
					edge.status !== "active" ||
					edge.src.kind !== "knowledge" ||
					out.has(edge.src.id)
				)
					continue;
				out.add(edge.src.id);
				next.push(edge.src.id);
			}
		frontier = next;
	}
	return out;
}

/** How many active knowledge rows `supersedes` the row directly (its first-hop absorbers). */
export function absorberCount(db: Database, id: string): number {
	const sources = new Set<string>();
	for (const edge of edgesTo(db, "knowledge", id, "supersedes"))
		if (edge.status === "active" && edge.src.kind === "knowledge")
			sources.add(edge.src.id);
	return sources.size;
}

export interface RefTargets {
	/** Keys search returns now (the gate system); empty means the ref is unreachable. */
	current: string[];
	/** Keys the atoms before distillation offered; may be empty although `current` is not. */
	baseline: string[];
}

/**
 * Resolves one relevant target row (already mapped from the legacy ref) for a case.
 * `null`: the ref is unreachable (it resolves, but search can never return it or a canonical
 * that replaced it) and is left out of both grade maps.
 */
export function resolveTargets(
	db: Database,
	evalCase: EvalCase,
	kind: "knowledge" | "episode",
	id: string,
): RefTargets | null {
	const facts = rowFacts(db, kind, id);
	if (!facts) return null;
	const current =
		kind === "knowledge"
			? currentTargets(db, evalCase, id).map((target) =>
					keyOf("knowledge", target),
				)
			: hybridReachable(evalCase, kind, facts)
				? [keyOf(kind, id)]
				: [];
	if (current.length === 0) return null;
	return {
		current,
		baseline: baselineReachable(evalCase, kind, facts) ? [keyOf(kind, id)] : [],
	};
}
