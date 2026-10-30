import { z } from "zod";

/**
 * What the LLM may return, all strict. An atom is given to the model under a local alias a1..aN
 * (an episode e1..eN); a UUID never enters a prompt. Output is untrusted: it is stored only after
 * the schema and the host checks (service/checks) accept it.
 */
export const alias = z.string().regex(/^[ae][1-9][0-9]?$/);

export const assessOutput = z.strictObject({
	schemaVersion: z.literal(1),
	items: z
		.array(
			z.strictObject({
				ref: alias,
				generality: z.enum([
					"general",
					"generalizable",
					"repo_specific",
					"unusable",
				]),
				reason: z.string().max(200),
			}),
		)
		.min(1)
		.max(20),
});
export type AssessOutput = z.infer<typeof assessOutput>;

const claim = z.strictObject({
	text: z.string().min(1).max(400),
	support: z.array(alias).min(1),
});

export const canonicalDraft = z.strictObject({
	type: z.enum(["rule", "procedure"]),
	polarity: z.enum(["positive", "negative"]),
	title: z.string().min(1).max(120),
	situation: z.string().min(1).max(600),
	guidance: z.string().min(1).max(2000),
	rationale: z.string().max(800),
	appliesWhen: z.array(z.string().max(200)).max(8),
	notAppliesWhen: z.array(z.string().max(200)).max(8),
	steps: z.array(z.string().max(300)).max(12),
	exceptions: z.array(z.string().max(200)).max(8),
	/** The claims of the body, one sentence each, with the aliases that support them. */
	claims: z.array(claim).min(1).max(16),
});
export type CanonicalDraft = z.infer<typeof canonicalDraft>;

export const plannerOutput = z.strictObject({
	schemaVersion: z.literal(1),
	groups: z
		.array(
			z.strictObject({
				members: z.array(alias).min(1),
				disposition: z.enum(["canonical", "repo_specific", "unusable"]),
				canonical: canonicalDraft.nullable(),
			}),
		)
		.min(1),
	relations: z
		.array(
			z.strictObject({
				/** Indexes into `groups`. */
				a: z.number().int().min(0),
				b: z.number().int().min(0),
				kind: z.enum(["condition_split", "conflict"]),
				note: z.string().max(300),
			}),
		)
		.max(16),
});
export type PlannerOutput = z.infer<typeof plannerOutput>;
export type PlannerGroup = PlannerOutput["groups"][number];

const check = z.enum(["preserved", "not_preserved", "unknown"]);
export const verifierOutput = z.strictObject({
	schemaVersion: z.literal(1),
	verdict: z.enum(["supported", "rejected", "unknown"]),
	claims: z.array(
		z.strictObject({
			index: z.number().int().min(0),
			entailed: z.enum(["yes", "no", "unknown"]),
		}),
	),
	checks: z.strictObject({
		conditions: check,
		negation: check,
		exceptions: check,
		numbersAndUnits: check,
		situationFaithful: check,
		noNewMeaning: check,
		noRepoSpecifics: check,
	}),
	rationale: z.string().max(800),
});
export type VerifierOutput = z.infer<typeof verifierOutput>;

export const pairOutput = z.strictObject({
	schemaVersion: z.literal(1),
	pairs: z
		.array(
			z.strictObject({
				index: z.number().int().min(0),
				verdict: z.enum([
					"duplicate",
					"compatible",
					"condition_split",
					"conflict",
					"unrelated",
					"unknown",
				]),
				/** Non-empty only for `condition_split`. */
				aNotAppliesWhen: z.array(z.string().max(200)).max(3),
				bNotAppliesWhen: z.array(z.string().max(200)).max(3),
				note: z.string().max(300),
			}),
		)
		.min(1)
		.max(8),
});
export type PairOutput = z.infer<typeof pairOutput>;

export const themeOutput = z.strictObject({
	schemaVersion: z.literal(1),
	name: z.string().min(1).max(40),
	description: z.string().max(300),
	aliases: z.array(z.string().max(40)).max(8),
	overview: z.string().max(600),
	keyMembers: z.array(alias).max(8),
	cautions: z.array(z.string().max(200)).max(5),
	openQuestions: z.array(z.string().max(200)).max(5),
});
export type ThemeOutput = z.infer<typeof themeOutput>;

export const examplesOutput = z.strictObject({
	schemaVersion: z.literal(1),
	examples: z
		.array(
			z.strictObject({
				situation: z.string().max(300),
				action: z.string().max(300),
				outcome: z.string().max(300),
				episodes: z.array(alias).min(1),
			}),
		)
		.max(2),
});
export type ExamplesOutput = z.infer<typeof examplesOutput>;
