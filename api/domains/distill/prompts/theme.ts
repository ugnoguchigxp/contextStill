/**
 * Prompt of the theme knowledge (6.9). The model sees canonical items under local aliases a1..aN;
 * an id never enters the text. Bump the version when the text changes: it is part of the reuse key.
 */
export const THEME_PROMPT_VERSION = "theme.v1";

export const THEME_SYSTEM = `You write the knowledge page of one theme in a knowledge map. A theme groups canonical items (reusable engineering guidance) that are close in meaning.

You are given the items nearest to the center of the theme, each under an alias a1, a2, ... Write in the language of the items.

Return one JSON object and nothing else:
{
  "schemaVersion": 1,
  "name": string,            // 1-40 characters, a noun phrase that names the theme
  "description": string,     // at most 300 characters: what the theme covers
  "aliases": string[],       // at most 8 other names or search words for the theme
  "overview": string,        // at most 600 characters: what a reader should know about the theme
  "keyMembers": string[],    // at most 8 aliases of the items that best represent the theme
  "cautions": string[],      // at most 5 items, each at most 200 characters: pitfalls the items warn about
  "openQuestions": string[]  // at most 5 items, each at most 200 characters: what the items leave unresolved
}

Rules:
- Say only what the items support. Do not add facts, numbers or advice that are not in them.
- The page must read for any project: do not write repository names, project names, file paths, port numbers or identifiers of one codebase.
- keyMembers may use only the aliases you were given, each at most once.
- Leave a list empty rather than inventing an entry.`;

export interface ThemePromptItem {
	alias: string;
	title: string;
	situation: string;
	body: string;
}

const clip = (text: string, max: number) =>
	text.length <= max ? text : `${text.slice(0, max)}...`;

export function themeUser(input: {
	level: 1 | 2;
	items: readonly ThemePromptItem[];
}): string {
	const kind =
		input.level === 1
			? "a broad theme that gathers several narrower themes"
			: "a narrow theme";
	const lines = [
		`The theme is ${kind}. These are the items nearest to its center:`,
		"",
	];
	for (const item of input.items) {
		lines.push(
			`[${item.alias}] ${clip(item.title, 160)}`,
			`situation: ${clip(item.situation, 300)}`,
			`guidance: ${clip(item.body, 500)}`,
			"",
		);
	}
	return lines.join("\n").trimEnd();
}

/** The same request with the host's findings appended (one correction is allowed). */
export function themeRepairUser(base: string, findings: string[]): string {
	return `${base}\n\nYour previous answer was rejected by the checks below. Answer again and fix exactly these points:\n${findings.map((f) => `- ${f}`).join("\n")}`;
}
