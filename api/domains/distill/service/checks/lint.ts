import type { CanonicalDraft } from "../../contracts";
import { repoSignals, type TermSet } from "./signals";

export interface GeneralizationViolation {
	code: "repo_term" | "absolute_path" | "relative_path" | "port";
	/** e.g. `title`, `steps[2]` */
	field: string;
	match: string;
}

/** The text fields of a draft that must not carry repo specifics (6.4). */
export function draftFields(draft: CanonicalDraft): [string, string][] {
	const list = (name: string, values: readonly string[]): [string, string][] =>
		values.map((v, i) => [`${name}[${i}]`, v]);
	return [
		["title", draft.title],
		["situation", draft.situation],
		["guidance", draft.guidance],
		["rationale", draft.rationale],
		...list("appliesWhen", draft.appliesWhen),
		...list("notAppliesWhen", draft.notAppliesWhen),
		...list("steps", draft.steps),
		...list("exceptions", draft.exceptions),
	];
}

/** Repo names, absolute and repo-relative paths and ports must not appear in a canonical. */
export function lintGeneralization(
	draft: CanonicalDraft,
	repoTerms: TermSet,
): GeneralizationViolation[] {
	const violations: GeneralizationViolation[] = [];
	for (const [field, text] of draftFields(draft)) {
		const s = repoSignals(text, repoTerms);
		for (const match of s.repoTerms)
			violations.push({ code: "repo_term", field, match });
		for (const match of s.absolutePaths)
			violations.push({ code: "absolute_path", field, match });
		for (const match of s.relativePaths)
			violations.push({ code: "relative_path", field, match });
		for (const match of s.ports)
			violations.push({ code: "port", field, match });
	}
	return violations;
}

/** Strings of a facet value: the value itself, its elements, or the text of anything else. */
export function facetStrings(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value))
		return value.flatMap((v) => (typeof v === "string" ? [v] : []));
	return [JSON.stringify(value) ?? ""];
}

/** Facets are copied from the members into a global canonical: the same signs are not allowed there. */
export function lintFacets(
	facets: Record<string, unknown>,
	repoTerms: TermSet,
): GeneralizationViolation[] {
	const violations: GeneralizationViolation[] = [];
	for (const [key, value] of Object.entries(facets))
		facetStrings(value).forEach((text, i) => {
			const s = repoSignals(text, repoTerms);
			const field = `facets.${key}[${i}]`;
			for (const match of s.repoTerms)
				violations.push({ code: "repo_term", field, match });
			for (const match of s.absolutePaths)
				violations.push({ code: "absolute_path", field, match });
			for (const match of s.relativePaths)
				violations.push({ code: "relative_path", field, match });
			for (const match of s.ports)
				violations.push({ code: "port", field, match });
		});
	return violations;
}
