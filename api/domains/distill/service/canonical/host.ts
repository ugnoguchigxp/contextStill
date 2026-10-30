import type { PlannerOutput } from "../../contracts";
import {
	checkNegation,
	checkNovelty,
	checkPolarity,
	lintGeneralization,
	validateAliases,
	validateRelations,
} from "../checks";
import type { AtomView, Violation } from "./types";

/** The text of an atom a claim may be drawn from. */
export function atomText(atom: AtomView): string {
	const r = atom.row;
	return [
		r.title,
		r.body,
		...r.appliesWhen,
		...r.notAppliesWhen,
		...r.steps,
	].join("\n");
}

export interface HostContext {
	atoms: readonly AtomView[];
	repoTerms: readonly string[];
	mode: "cluster" | "singles";
}

/**
 * The deterministic checks of 6.4 on a planner answer. Every finding names a kind and a place
 * (aliases, indexes, field names, matched literals); no model prose is copied into it.
 */
export function checkPlan(plan: PlannerOutput, ctx: HostContext): Violation[] {
	const byAlias = new Map(ctx.atoms.map((a) => [a.alias, a]));
	const violations: Violation[] = [
		...validateAliases(plan.groups, byAlias.keys()),
		...validateRelations(plan.relations, plan.groups.length),
	];
	if (ctx.mode === "singles")
		plan.groups.forEach((g, groupIndex) => {
			if (g.members.length !== 1)
				violations.push({
					code: "group_size",
					groupIndex,
					detail: `${g.members.length} members, expected 1`,
				});
		});
	plan.groups.forEach((group, groupIndex) => {
		if (group.canonical)
			violations.push(...checkDraft(plan, groupIndex, ctx, byAlias));
	});
	return violations;
}

function checkDraft(
	plan: PlannerOutput,
	groupIndex: number,
	ctx: HostContext,
	byAlias: ReadonlyMap<string, AtomView>,
): Violation[] {
	const group = plan.groups[groupIndex]!;
	const draft = group.canonical!;
	const inGroup = new Set(group.members);
	const out: Violation[] = [];
	draft.claims.forEach((claim, claimIndex) => {
		const supports = claim.support
			.filter((a) => inGroup.has(a))
			.map((a) => byAlias.get(a))
			.filter((a): a is AtomView => a !== undefined);
		// A support outside the group or unknown is reported by the alias check.
		if (supports.length === 0) return;
		const texts = supports.map(atomText);
		const result = checkNovelty(claim.text, texts);
		if (!result.ok)
			out.push({
				code: "claim_unsupported",
				groupIndex,
				detail:
					result.unsupportedLiterals.length > 0
						? `claim ${claimIndex}: literals not in the supporting atoms: ${result.unsupportedLiterals.join(", ")}`
						: `claim ${claimIndex}: only ${Math.round(result.ratio * 100)}% of its words are in the supporting atoms`,
			});
		if (!checkNegation(claim.text, texts).ok)
			out.push({
				code: "negation_mismatch",
				groupIndex,
				detail: `claim ${claimIndex}: negation differs from the supporting atoms`,
			});
	});
	// The lines of conditions, steps and exceptions have no support of their own: the group's
	// atoms together must hold them (and say them with the same negation).
	const groupTexts = group.members
		.map((a) => byAlias.get(a))
		.filter((a): a is AtomView => a !== undefined)
		.map(atomText);
	if (groupTexts.length > 0)
		for (const [name, lines] of [
			["appliesWhen", draft.appliesWhen],
			["notAppliesWhen", draft.notAppliesWhen],
			["steps", draft.steps],
			["exceptions", draft.exceptions],
		] as const)
			lines.forEach((line, i) => {
				const result = checkNovelty(line, groupTexts);
				if (!result.ok)
					out.push({
						code: "line_unsupported",
						groupIndex,
						detail:
							result.unsupportedLiterals.length > 0
								? `${name}[${i}]: literals not in the atoms: ${result.unsupportedLiterals.join(", ")}`
								: `${name}[${i}]: only ${Math.round(result.ratio * 100)}% of its words are in the atoms`,
					});
				if (!checkNegation(line, groupTexts).ok)
					out.push({
						code: "negation_mismatch",
						groupIndex,
						detail: `${name}[${i}]: negation differs from the atoms`,
					});
			});
	for (const v of lintGeneralization(draft, ctx.repoTerms))
		out.push({
			code: "repo_specific_text",
			groupIndex,
			detail: `${v.field}: ${v.code} ${v.match}`,
		});
	const members = group.members
		.map((a) => byAlias.get(a))
		.filter((a): a is AtomView => a !== undefined)
		.map((a) => ({ polarity: a.row.polarity }));
	if (members.length > 0 && !checkPolarity(draft, members).ok)
		out.push({
			code: "polarity_mismatch",
			groupIndex,
			detail: `draft ${draft.polarity}, the majority of the members is ${checkPolarity(draft, members).majority}`,
		});
	return out;
}

/** True when the members' polarities are split evenly (the group goes to the owner as well). */
export function polarityTie(
	group: PlannerOutput["groups"][number],
	byAlias: ReadonlyMap<string, AtomView>,
): boolean {
	const members = group.members
		.map((a) => byAlias.get(a))
		.filter((a): a is AtomView => a !== undefined)
		.map((a) => ({ polarity: a.row.polarity }));
	if (members.length === 0 || !group.canonical) return false;
	return checkPolarity(group.canonical, members).tie;
}
