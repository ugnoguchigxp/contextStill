import type { Database } from "bun:sqlite";
import { listUnresolvedConflictPairs } from "../../distill";

/**
 * Pairs whose judgment is `conflict` or `unknown` and not yet settled (the distill audit's
 * `unresolved_conflict`), restricted to pairs whose both sides are among `ids`. The caller passes
 * the ids of active canonical items only. Each pair is returned as the two ids in a < b order.
 */
export function unresolvedConflictPairs(
	db: Database,
	ids: readonly string[],
): [string, string][] {
	return listUnresolvedConflictPairs(db, ids);
}
