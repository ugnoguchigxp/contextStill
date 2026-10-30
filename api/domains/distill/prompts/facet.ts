/**
 * Prompt of the facet normalisation (6.9). A batch of at most 50 raw facet values is grouped into
 * concept names. The values are referred to by their index in the list.
 */
export const FACET_PROMPT_VERSION = "facet.v1";

export const FACET_SYSTEM = `You normalise the tags of a knowledge base. You are given a numbered list of raw tag values of one kind (domains, technologies or change types). Many of them are spellings, abbreviations, plurals or translations of the same concept.

Group the values that mean the same thing under one concept name. Return one JSON object and nothing else:
{
  "schemaVersion": 1,
  "concepts": [ { "name": string, "values": number[] } ]
}

Rules:
- name: 1-40 characters, lower case, the commonest short English form of the concept (keep an established product name as it is).
- values: indexes from the list, each index in at most one concept. Put a value that stands alone in a concept of its own.
- Leave out a value only when it is meaningless (a path, a sentence, an identifier).
- Never put values with different meanings together to reduce the number of concepts.`;

export function facetUser(input: {
	key: "domains" | "technologies" | "changeTypes";
	values: readonly string[];
}): string {
	const label = {
		domains: "domains",
		technologies: "technologies",
		changeTypes: "change types",
	}[input.key];
	return [
		`Kind: ${label}`,
		"",
		...input.values.map((value, index) => `${index}: ${value}`),
	].join("\n");
}

export function facetRepairUser(base: string, findings: string[]): string {
	return `${base}\n\nYour previous answer was rejected by the checks below. Answer again and fix exactly these points:\n${findings.map((f) => `- ${f}`).join("\n")}`;
}
