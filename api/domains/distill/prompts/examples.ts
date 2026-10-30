/**
 * Prompt of the generalised examples of a canonical (6.9). The candidate episodes are given under
 * local aliases e1..eN; an id never enters the text.
 */
export const EXAMPLES_PROMPT_VERSION = "examples.v1";

export const EXAMPLES_SYSTEM = `You write short worked examples for one piece of canonical engineering guidance, from past episodes of real work.

You are given the guidance and some candidate episodes, each under an alias e1, e2, ... Write in the language of the episodes.

Return one JSON object and nothing else:
{
  "schemaVersion": 1,
  "examples": [
    { "situation": string, "action": string, "outcome": string, "episodes": string[] }
  ]
}

Rules:
- At most 2 examples. Return an empty list when no episode shows the guidance being applied or ignored.
- situation, action and outcome: at most 300 characters each, none empty. What the situation was, what was done, what happened.
- episodes: the aliases of the episodes the example is generalised from (at least one, only the aliases you were given).
- Generalise: remove repository names, project names, file paths, port numbers and identifiers of one codebase, so that the example reads for any project.
- Say only what the episodes support. Do not invent causes, numbers or outcomes.`;

export interface ExamplesPromptEpisode {
	alias: string;
	title: string;
	situation: string;
	action: string;
	outcome: string;
	lesson: string;
}

const clip = (text: string, max: number) =>
	text.length <= max ? text : `${text.slice(0, max)}...`;

export function examplesUser(input: {
	title: string;
	situation: string;
	guidance: string;
	episodes: readonly ExamplesPromptEpisode[];
}): string {
	const lines = [
		"Guidance",
		`title: ${clip(input.title, 160)}`,
		`situation: ${clip(input.situation, 400)}`,
		`guidance: ${clip(input.guidance, 800)}`,
		"",
		"Candidate episodes",
		"",
	];
	for (const e of input.episodes)
		lines.push(
			`[${e.alias}] ${clip(e.title, 160)}`,
			`situation: ${clip(e.situation, 300)}`,
			`action: ${clip(e.action, 300)}`,
			`outcome: ${clip(e.outcome, 300)}`,
			`lesson: ${clip(e.lesson, 300)}`,
			"",
		);
	return lines.join("\n").trimEnd();
}

export function examplesRepairUser(base: string, findings: string[]): string {
	return `${base}\n\nYour previous answer was rejected by the checks below. Answer again and fix exactly these points:\n${findings.map((f) => `- ${f}`).join("\n")}`;
}
