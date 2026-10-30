/**
 * Repo names that are ordinary words (or third-party tool names) and so say nothing about a
 * specific repository. They are never repo terms. Add to this list, never to the matching code.
 */
export const GENERIC_REPO_WORDS: ReadonlySet<string> = new Set([
	"todolist",
	"todo",
	"wiki",
	"notes",
	"memo",
	"chat",
	"new-chat",
	"demo",
	"test",
	"tests",
	"testing",
	"sample",
	"samples",
	"example",
	"examples",
	"template",
	"templates",
	"docs",
	"core",
	"server",
	"client",
	"backend",
	"frontend",
	"mobile",
	"desktop",
	"dashboard",
	"project",
	"projects",
	"tools",
	"utils",
	"common",
	"shared",
	"main",
	"master",
	"work",
	"worktree",
	"worktrees",
	"playground",
	"sandbox",
	"scratch",
	"calendar",
	"library",
	"workspace",
	"repository",
	"quickquestion",
	"foundry",
	"openhands",
	"opencode",
	"flutter",
	"python",
	"rust",
	"java",
	"nextjs",
	"hono",
	"react",
	"vite",
	"bun",
	"node",
	"docker",
	"github",
	"claude",
	"codex",
	"gemini",
	"openai",
	"anthropic",
]);

const UUID_LIKE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const FILE_LIKE = /\.[a-z0-9]{1,5}$/;

/**
 * The repo terms for `repoSignals`: the lower-cased repo keys that are at least 4 characters,
 * not a generic word, not a UUID and not a file name. Sorted, without duplicates.
 */
export function buildRepoTerms(
	repoKeys: Iterable<string | null | undefined>,
): string[] {
	const terms = new Set<string>();
	for (const key of repoKeys) {
		if (typeof key !== "string") continue;
		const term = key.trim().toLowerCase();
		if (
			term.length < 4 ||
			GENERIC_REPO_WORDS.has(term) ||
			UUID_LIKE.test(term) ||
			FILE_LIKE.test(term) ||
			/^[0-9._-]+$/.test(term)
		)
			continue;
		terms.add(term);
	}
	return [...terms].sort();
}
