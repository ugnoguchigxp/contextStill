import type { Database } from "bun:sqlite";
import { z } from "zod";
import { getFacetConcept, type FacetKey } from "../../../map";
import { repoSignals, type TermSet } from "../checks";
import { FACET_KEYS, type FacetKeyName } from "./queries";

/** Raw values longer than this are ignored by the model (they are sentences, not tags). */
export const FACET_VALUE_MAX = 80;
/** Values per model call. */
export const FACET_BATCH = 50;

/** What the model may return for a batch of facet values; local to this stage. */
export const facetOutput = z.strictObject({
	schemaVersion: z.literal(1),
	concepts: z
		.array(
			z.strictObject({
				name: z.string().min(1).max(40),
				values: z.array(z.number().int().min(0)).min(1).max(FACET_BATCH),
			}),
		)
		.max(FACET_BATCH),
});
export type FacetOutput = z.infer<typeof facetOutput>;

export interface FacetMapping {
	facetKey: FacetKeyName;
	rawValue: string;
	themeId: string;
	/** Atoms that voted for the theme, and all atoms that voted. */
	votes: number;
	total: number;
}
export interface FacetBatch {
	key: FacetKeyName;
	values: string[];
}

export interface FacetDecision {
	mapped: FacetMapping[];
	undecided: { facetKey: FacetKeyName; rawValue: string }[];
}

/**
 * The deterministic part of the normalisation (6.9): a value goes to the narrow theme that holds
 * the canonicals the atoms with that value were absorbed into, when more than half of those atoms
 * agree. Every other value (no atom absorbed, or no majority) is undecided and goes to the model.
 */
export function decideFacets(
	evidence: ReadonlyMap<FacetKeyName, ReadonlyMap<string, readonly string[]>>,
	themeOf: ReadonlyMap<string, string>,
): FacetDecision {
	const mapped: FacetMapping[] = [];
	const undecided: FacetDecision["undecided"] = [];
	for (const key of FACET_KEYS) {
		for (const [rawValue, canonicals] of evidence.get(key) ?? []) {
			const votes = new Map<string, number>();
			let total = 0;
			for (const canonical of canonicals) {
				const theme = themeOf.get(canonical);
				if (theme === undefined) continue;
				total++;
				votes.set(theme, (votes.get(theme) ?? 0) + 1);
			}
			let top: string | null = null;
			let topVotes = 0;
			for (const [theme, count] of [...votes].sort(([a], [b]) =>
				a < b ? -1 : 1,
			))
				if (count > topVotes) {
					top = theme;
					topVotes = count;
				}
			if (top !== null && topVotes * 2 > total)
				mapped.push({
					facetKey: key,
					rawValue,
					themeId: top,
					votes: topVotes,
					total,
				});
			else undecided.push({ facetKey: key, rawValue });
		}
	}
	return { mapped, undecided };
}

/**
 * The batches for the model (read only). A value that already has a mapping of the owner (human)
 * or of an earlier model run is not asked again; a value whose only mapping is a deterministic
 * one that no longer holds is asked.
 */
export function planFacetBatches(
	db: Database,
	undecided: FacetDecision["undecided"],
	limit?: number,
): { batches: FacetBatch[]; skipped: number } {
	const byKey = new Map<FacetKeyName, string[]>(FACET_KEYS.map((k) => [k, []]));
	let skipped = 0;
	for (const { facetKey, rawValue } of undecided) {
		if (rawValue.length > FACET_VALUE_MAX) {
			skipped++;
			continue;
		}
		const existing = getFacetConcept(db, facetKey as FacetKey, rawValue);
		if (existing && existing.origin !== "deterministic") {
			skipped++;
			continue;
		}
		byKey.get(facetKey)!.push(rawValue);
	}
	const batches: FacetBatch[] = [];
	for (const key of FACET_KEYS) {
		const values = byKey.get(key)!;
		for (let i = 0; i < values.length; i += FACET_BATCH)
			batches.push({ key, values: values.slice(i, i + FACET_BATCH) });
	}
	return {
		batches: limit === undefined ? batches : batches.slice(0, limit),
		skipped,
	};
}

/**
 * Host check of a model answer: the indexes exist, each is used once, and no concept name carries
 * a repository name, a path or a port. The findings never quote the model's words.
 */
export function checkFacetOutput(
	output: FacetOutput,
	count: number,
	repoTerms: TermSet,
): string[] {
	const findings: string[] = [];
	const seen = new Set<number>();
	output.concepts.forEach((concept, c) => {
		const s = repoSignals(concept.name, repoTerms);
		if (
			s.repoTerms.length ||
			s.absolutePaths.length ||
			s.relativePaths.length ||
			s.ports.length
		)
			findings.push(
				`concept ${c}: the name carries a repository name, path or port`,
			);
		for (const index of concept.values) {
			if (index >= count)
				findings.push(`concept ${c}: index ${index} is not in the list`);
			else if (seen.has(index))
				findings.push(`concept ${c}: index ${index} is used twice`);
			else seen.add(index);
		}
	});
	return findings;
}

/** value -> concept name, from an answer that passed `checkFacetOutput`. */
export function conceptsOf(output: FacetOutput, values: readonly string[]) {
	const out: { rawValue: string; concept: string }[] = [];
	for (const concept of output.concepts)
		for (const index of concept.values)
			out.push({
				rawValue: values[index]!,
				concept: concept.name.trim().toLowerCase(),
			});
	return out;
}
