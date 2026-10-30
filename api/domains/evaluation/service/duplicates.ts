import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import {
	listUnresolvedConflictPairs,
	type PairVerdict,
	type PairVerdictKind,
} from "../../distill";
import { absorberCount, claimSet } from "./resolve";

export type JudgePairs = (
	pairs: { a: string; b: string }[],
	signal?: AbortSignal,
) => Promise<PairVerdict[]>;

export interface RankedHit {
	kind: "knowledge" | "episode";
	id: string;
}

export interface DupConflict {
	/** null: a pair of canonicals in the top k has no judgment (run with `--judge`). */
	dupRate: number | null;
	conflictRate: number | null;
}

interface Verdict {
	verdict: PairVerdictKind;
	/**
	 * The MCP warns about the pair (`listUnresolvedConflictPairs`: `conflict` or `unknown`, not yet
	 * settled), so it is not a silent conflict.
	 */
	warned: boolean;
	/** settled (`a_wins`, `b_wins`, `owner_resolved`): both rows may stay active and are compatible */
	settled: boolean;
}

interface KnowledgeFacts {
	layer: string;
	digest: string;
	claim: Set<string>;
	/** absorbed by two or more rows: it states pieces of several claims */
	multi: boolean;
}

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/**
 * Whether two knowledge hits state the same claim: one is in the other's closure (the canonical
 * that absorbed it, however many stages up), or both reach a common canonical. A row absorbed by
 * several canonicals (`multi`) belongs to each of them without making them one claim, so it
 * does not link two hits through a canonical they merely share with it.
 */
const sameClaim = (
	x: string,
	fx: KnowledgeFacts,
	y: string,
	fy: KnowledgeFacts,
) => {
	if (fx.claim.has(y) || fy.claim.has(x)) return true;
	if (fx.multi || fy.multi) return false;
	for (const id of fx.claim) if (fy.claim.has(id)) return true;
	return false;
};

const SETTLED_RESOLUTIONS: ReadonlySet<string> = new Set([
	"a_wins",
	"b_wins",
	"owner_resolved",
]);

/**
 * Duplicate and conflict rates of the top-k lists of each system (plan 8.3).
 *
 * - dupRate@k: hits that restate a higher-ranked hit / all hits. Two knowledge rows state the
 *   same claim when their `supersedes` closures meet (both absorbed into one canonical, or
 *   one is the canonical of the other); two canonicals also when `distill_pair_judgments`
 *   says `duplicate`.
 * - conflictRate@k: queries whose top k contain a pair judged `conflict` that search does not
 *   warn about. "Warns" is the MCP's predicate itself (`listUnresolvedConflictPairs`), and a pair
 *   settled (`a_wins`, `b_wins`, `owner_resolved`) is compatible, so neither counts; what is left
 *   is a conflict judged in this run (`--judge`) that the table does not hold yet.
 *
 * `lists` is keyed by any label (a system, or a style with a system). A judgment counts only while both content digests are the ones judged. Canonical pairs
 * without one are judged by `judge` when given, else the rates of that system are null.
 */
export async function dupConflictRates(
	store: SqliteStore,
	lists: ReadonlyMap<string, readonly (readonly RankedHit[])[]>,
	judge: JudgePairs | null,
): Promise<{ rates: Map<string, DupConflict>; judged: number }> {
	const facts = new Map<string, KnowledgeFacts | null>();
	const stored = new Map<string, Verdict | null>();
	const factsOf = (db: Database) => {
		return (id: string) => {
			let found = facts.get(id);
			if (found === undefined) {
				const row = db
					.query<{ layer: string; content_digest: string }, [string]>(
						"SELECT layer, content_digest FROM knowledge_items WHERE id = ?",
					)
					.get(id);
				found = row
					? {
							layer: row.layer,
							digest: row.content_digest,
							claim: claimSet(db, id),
							multi: absorberCount(db, id) > 1,
						}
					: null;
				facts.set(id, found);
			}
			return found;
		};
	};

	// Pass 1 (one read): facts of every knowledge hit, stored judgments of every open pair.
	const unjudged = new Map<string, { a: string; b: string }>();
	store.read((db) => {
		const factOf = factsOf(db);
		for (const perSystem of lists.values())
			for (const hits of perSystem) {
				const ids = uniqueKnowledge(hits);
				for (const id of ids) factOf(id);
				for (const [x, y] of pairsOf(ids)) {
					const fx = factOf(x);
					const fy = factOf(y);
					if (
						!fx ||
						!fy ||
						fx.layer !== "canonical" ||
						fy.layer !== "canonical"
					)
						continue;
					if (sameClaim(x, fx, y, fy)) continue;
					const key = pairKey(x, y);
					if (stored.has(key)) continue;
					const row = db
						.query<
							{
								a_digest: string;
								b_digest: string;
								verdict: PairVerdictKind;
								resolution: string;
							},
							[string, string]
						>(
							"SELECT a_digest, b_digest, verdict, resolution FROM distill_pair_judgments WHERE a_id = ? AND b_id = ?",
						)
						.get(x < y ? x : y, x < y ? y : x);
					const [a, b] = x < y ? [fx, fy] : [fy, fx];
					const valid =
						row !== null &&
						row.a_digest === a.digest &&
						row.b_digest === b.digest;
					stored.set(
						key,
						valid
							? {
									verdict: row.verdict,
									warned: listUnresolvedConflictPairs(db, [x, y]).length > 0,
									settled: SETTLED_RESOLUTIONS.has(row.resolution),
								}
							: null,
					);
					if (!valid)
						unjudged.set(key, x < y ? { a: x, b: y } : { a: y, b: x });
				}
			}
	});

	// Judge what is missing (only with --judge). The verdicts live in this run only.
	const judgedBy = new Set<string>();
	if (judge && unjudged.size > 0) {
		const verdicts = await judge([...unjudged.values()]);
		for (const v of verdicts) {
			const key = pairKey(v.a, v.b);
			if (!unjudged.has(key)) continue;
			stored.set(key, {
				verdict: v.verdict,
				warned: false,
				settled: false,
			});
			judgedBy.add(key);
		}
	}

	const out = new Map<string, DupConflict>();
	for (const [system, perSystem] of lists) {
		let complete = true;
		let hitTotal = 0;
		let dup = 0;
		let conflictQueries = 0;
		for (const hits of perSystem) {
			const ids = uniqueKnowledge(hits);
			hitTotal += uniqueHits(hits).length;
			const seenIds: string[] = [];
			let conflicted = false;
			for (const id of ids) {
				const fy = facts.get(id) ?? null;
				let isDup = false;
				for (const earlier of seenIds) {
					const fx = facts.get(earlier) ?? null;
					if (!fx || !fy) continue;
					if (sameClaim(earlier, fx, id, fy)) {
						isDup = true;
						continue;
					}
					if (fx.layer !== "canonical" || fy.layer !== "canonical") continue;
					const key = pairKey(earlier, id);
					const verdict = stored.get(key);
					if (!verdict) {
						complete = false;
						continue;
					}
					if (verdict.verdict === "duplicate") isDup = true;
					if (
						verdict.verdict === "conflict" &&
						!verdict.warned &&
						!verdict.settled
					)
						conflicted = true;
				}
				if (isDup) dup += 1;
				seenIds.push(id);
			}
			if (conflicted) conflictQueries += 1;
		}
		out.set(
			system,
			complete
				? {
						dupRate: hitTotal === 0 ? 0 : dup / hitTotal,
						conflictRate:
							perSystem.length === 0 ? 0 : conflictQueries / perSystem.length,
					}
				: { dupRate: null, conflictRate: null },
		);
	}
	return { rates: out, judged: judgedBy.size };
}

function uniqueHits(hits: readonly RankedHit[]): RankedHit[] {
	const seen = new Set<string>();
	return hits.filter((hit) => {
		const key = `${hit.kind}:${hit.id}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

const uniqueKnowledge = (hits: readonly RankedHit[]): string[] =>
	uniqueHits(hits)
		.filter((hit) => hit.kind === "knowledge")
		.map((hit) => hit.id);

function* pairsOf(ids: readonly string[]): Generator<[string, string]> {
	for (let j = 1; j < ids.length; j++)
		for (let i = 0; i < j; i++) yield [ids[i]!, ids[j]!];
}
