import type { PlannerOutput } from "../../contracts";

export type HostViolationCode =
	| "unknown_alias"
	| "support_outside_group"
	| "coverage_missing"
	| "coverage_duplicate"
	| "canonical_mismatch"
	| "relation_index"
	| "claim_unsupported"
	| "line_unsupported"
	| "negation_mismatch"
	| "repo_specific_text"
	| "polarity_mismatch";

/**
 * A host check failed. `detail` names the place (aliases, indexes, field names, matched
 * literals) and never quotes model prose beyond that, so it can be shown to the planner as is.
 */
export interface HostViolation {
	code: HostViolationCode;
	/** Index into `groups`, null when the violation is not about one group. */
	groupIndex: number | null;
	detail: string;
}

export interface AliasGroup {
	members: readonly string[];
	disposition?: "canonical" | "repo_specific" | "unusable";
	canonical?: { claims: readonly { support: readonly string[] }[] } | null;
}

/**
 * The alias rules of 6.4: every alias of `members` and `support` exists in the input, every
 * `support` alias is a member of its own group, every input alias is in exactly one group, and
 * a `canonical` draft is present exactly when the disposition is `canonical`.
 */
export function validateAliases(
	groups: readonly AliasGroup[],
	input: Iterable<string>,
): HostViolation[] {
	const known = new Set(input);
	const violations: HostViolation[] = [];
	const seen = new Map<string, number>();
	groups.forEach((group, index) => {
		const members = new Set(group.members);
		for (const alias of group.members) {
			if (!known.has(alias))
				violations.push({
					code: "unknown_alias",
					groupIndex: index,
					detail: `member ${alias}`,
				});
			const first = seen.get(alias);
			if (first !== undefined)
				violations.push({
					code: "coverage_duplicate",
					groupIndex: index,
					detail: `${alias} is also in group ${first}`,
				});
			else seen.set(alias, index);
		}
		group.canonical?.claims.forEach((claim, claimIndex) => {
			for (const alias of claim.support) {
				if (!known.has(alias))
					violations.push({
						code: "unknown_alias",
						groupIndex: index,
						detail: `support ${alias} of claim ${claimIndex}`,
					});
				else if (!members.has(alias))
					violations.push({
						code: "support_outside_group",
						groupIndex: index,
						detail: `support ${alias} of claim ${claimIndex}`,
					});
			}
		});
		if (group.disposition !== undefined) {
			const has = group.canonical !== null && group.canonical !== undefined;
			if (has !== (group.disposition === "canonical"))
				violations.push({
					code: "canonical_mismatch",
					groupIndex: index,
					detail: `disposition ${group.disposition}`,
				});
		}
	});
	for (const alias of known)
		if (!seen.has(alias))
			violations.push({
				code: "coverage_missing",
				groupIndex: null,
				detail: alias,
			});
	return violations;
}

/** Each relation names two different groups that exist. */
export function validateRelations(
	relations: PlannerOutput["relations"],
	groupCount: number,
): HostViolation[] {
	const violations: HostViolation[] = [];
	relations.forEach((r, index) => {
		if (r.a >= groupCount || r.b >= groupCount || r.a === r.b)
			violations.push({
				code: "relation_index",
				groupIndex: null,
				detail: `relation ${index} (${r.a}, ${r.b})`,
			});
	});
	return violations;
}
