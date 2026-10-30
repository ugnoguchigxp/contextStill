export {
	validateAliases,
	validateRelations,
	type AliasGroup,
	type HostViolation,
	type HostViolationCode,
} from "./aliases";
export {
	lintFacets,
	lintGeneralization,
	draftFields,
	type GeneralizationViolation,
} from "./lint";
export {
	checkNegation,
	checkNovelty,
	contentWords,
	hasNegation,
	literalsOf,
	NOVELTY_MIN_RATIO,
	type NegationResult,
	type NoveltyResult,
} from "./novelty";
export { checkPolarity, type PolarityResult } from "./polarity";
export { buildRepoTerms, GENERIC_REPO_WORDS } from "./repo-terms";
export {
	hasAnySignal,
	hasConcreteSignals,
	repoSignals,
	type RepoSignals,
	type TermSet,
} from "./signals";
