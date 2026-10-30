export interface RepoSignals {
	/** Repo terms found, lower-case, sorted. */
	repoTerms: string[];
	/** `/Users/…`, `/home/…`, `~/…`, `C:\…` */
	absolutePaths: string[];
	/** `src/a/b.ts`-like paths */
	relativePaths: string[];
	/** `localhost:3000`, `port 8080` */
	ports: string[];
}

export type TermSet = ReadonlySet<string> | readonly string[];

const ABSOLUTE_PATH =
	/(?:\/Users\/|\/home\/)[^\s"'`)\]]*|~\/[^\s"'`)\]]*|(?<![A-Za-z])[A-Za-z]:\\[^\s"'`)\]]*/g;
const RELATIVE_PATH =
	/[\w.-]+\/[\w./-]+\.(?:ts|tsx|js|rs|py|go|md|json|toml|sql|yml|yaml|dart)(?![\w])/g;
const PORT = /(?:localhost|127\.0\.0\.1|\[::1\]):\d{2,5}|port\s*\d{4,5}/gi;
const TOKEN = /[a-z0-9]+(?:[-_.][a-z0-9]+)*/g;

const unique = (values: Iterable<string>) => [...new Set(values)].sort();

/**
 * The deterministic signs that a text is about one repository. A repo term matches a whole
 * ASCII token (`nightworkers`, `nightworkers-api` through its `-_.`-separated parts), compared
 * case-insensitively; it never matches inside a longer word.
 */
export function repoSignals(text: string, repoTerms: TermSet): RepoSignals {
	const terms = repoTerms instanceof Set ? repoTerms : new Set(repoTerms);
	const absolutePaths = unique(text.match(ABSOLUTE_PATH) ?? []);
	// Absolute paths contain relative-looking tails; they are reported once, as absolute.
	const rest = text.replace(ABSOLUTE_PATH, " ");
	const relativePaths = unique(rest.match(RELATIVE_PATH) ?? []);
	const ports = unique(text.match(PORT) ?? []);
	const found = new Set<string>();
	for (const token of text.toLowerCase().match(TOKEN) ?? []) {
		if (terms.has(token)) found.add(token);
		for (const part of token.split(/[-_.]/))
			if (part !== token && terms.has(part)) found.add(part);
	}
	return { repoTerms: [...found].sort(), absolutePaths, relativePaths, ports };
}

/** True when a path or a port is present (the signs (b)(c)(d) of 6.1). */
export function hasConcreteSignals(signals: RepoSignals): boolean {
	return (
		signals.absolutePaths.length > 0 ||
		signals.relativePaths.length > 0 ||
		signals.ports.length > 0
	);
}

export function hasAnySignal(signals: RepoSignals): boolean {
	return signals.repoTerms.length > 0 || hasConcreteSignals(signals);
}
