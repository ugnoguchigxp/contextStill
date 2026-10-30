import { expect, test } from "bun:test";
import type { CanonicalDraft } from "../../contracts";
import {
	buildRepoTerms,
	checkNegation,
	checkNovelty,
	checkPolarity,
	hasNegation,
	lintFacets,
	lintGeneralization,
	repoSignals,
	validateAliases,
	validateRelations,
} from "./index";

const terms = buildRepoTerms([
	"NightWorkers",
	"contextstill",
	"todolist",
	"api",
	"a1b2",
	null,
	"deepstill-codex-mgtulv",
	"implementation_plan.md",
	"12782725-7101-42a3-ac58-8d78211f7e7a",
]);

test("buildRepoTerms keeps repo-like names of four or more characters only", () => {
	expect(terms).toEqual([
		"a1b2",
		"contextstill",
		"deepstill-codex-mgtulv",
		"nightworkers",
	]);
});

// ---- repoSignals -----------------------------------------------------------------------

test("repoSignals finds repo terms as whole tokens, case-insensitively", () => {
	expect(repoSignals("NightWorkers の設定を直す", terms).repoTerms).toEqual([
		"nightworkers",
	]);
	expect(
		repoSignals("see nightworkers-api for details", terms).repoTerms,
	).toEqual(["nightworkers"]);
	expect(
		repoSignals("deepstill-codex-mgtulv worktree", terms).repoTerms,
	).toEqual(["deepstill-codex-mgtulv"]);
	// counterexamples: inside a longer word, a generic word, no term at all
	expect(
		repoSignals("nightworkersplus and a nightworker", terms).repoTerms,
	).toEqual([]);
	expect(repoSignals("todolist app", terms).repoTerms).toEqual([]);
	expect(repoSignals("一般的なデータベースの話", terms).repoTerms).toEqual([]);
});

test("repoSignals finds absolute paths", () => {
	for (const text of [
		"edit /Users/alice/Code/app/index.ts now",
		"see /home/bob/.config/x",
		"open ~/Library/Application Support/x",
		"C:\\Users\\bob\\proj\\a.txt",
	])
		expect(repoSignals(text, terms).absolutePaths.length).toBe(1);
	expect(
		repoSignals("use the / and \\ keys, e.g. a:b", terms).absolutePaths,
	).toEqual([]);
});

test("repoSignals finds repo-relative paths and does not count an absolute path twice", () => {
	expect(
		repoSignals("change api/domains/search/service/index.ts", terms)
			.relativePaths,
	).toEqual(["api/domains/search/service/index.ts"]);
	expect(
		repoSignals("src/main.rs and docs/plan.md", terms).relativePaths,
	).toEqual(["docs/plan.md", "src/main.rs"]);
	const abs = repoSignals("/Users/a/Code/x/src/main.ts", terms);
	expect(abs.absolutePaths.length).toBe(1);
	expect(abs.relativePaths).toEqual([]);
	// counterexamples: a name without a directory, a directory without a known extension
	expect(
		repoSignals("edit index.ts, or the src/ directory, or a/b", terms)
			.relativePaths,
	).toEqual([]);
});

test("repoSignals finds ports", () => {
	expect(repoSignals("listen on localhost:39181", terms).ports).toEqual([
		"localhost:39181",
	]);
	expect(
		repoSignals("curl 127.0.0.1:8080 and [::1]:3000", terms).ports,
	).toEqual(["127.0.0.1:8080", "[::1]:3000"]);
	expect(repoSignals("the Port 39171 is taken", terms).ports).toEqual([
		"Port 39171",
	]);
	expect(
		repoSignals("set the port to a free one; at 12:30; localhost:1", terms)
			.ports,
	).toEqual([]);
});

// ---- validateAliases -------------------------------------------------------------------

const group = (members: string[], supports: string[][] = [members]) => ({
	members,
	disposition: "canonical" as const,
	canonical: { claims: supports.map((support) => ({ support })) },
});
const codes = (v: { code: string }[]) => v.map((x) => x.code);

test("validateAliases accepts a partition whose supports are inside their group", () => {
	expect(
		validateAliases(
			[group(["a1", "a2"], [["a1"], ["a2", "a1"]]), group(["a3"])],
			["a1", "a2", "a3"],
		),
	).toEqual([]);
	// a repo_specific group has no draft
	expect(
		validateAliases(
			[{ members: ["a1"], disposition: "repo_specific", canonical: null }],
			["a1"],
		),
	).toEqual([]);
});

test("validateAliases rejects aliases that are not in the input", () => {
	const v = validateAliases([group(["a1", "a9"])], ["a1"]);
	expect(codes(v)).toContain("unknown_alias");
	expect(v.find((x) => x.code === "unknown_alias")!.detail).toBe("member a9");
});

test("validateAliases rejects a support outside its group and an unknown support", () => {
	const v = validateAliases(
		[group(["a1"], [["a2"]]), group(["a2"], [["a7"]])],
		["a1", "a2"],
	);
	expect(v).toEqual([
		{
			code: "support_outside_group",
			groupIndex: 0,
			detail: "support a2 of claim 0",
		},
		{ code: "unknown_alias", groupIndex: 1, detail: "support a7 of claim 0" },
	]);
});

test("validateAliases rejects a missing member and a member used twice", () => {
	expect(validateAliases([group(["a1"])], ["a1", "a2"])).toEqual([
		{ code: "coverage_missing", groupIndex: null, detail: "a2" },
	]);
	expect(
		validateAliases([group(["a1", "a2"]), group(["a2"])], ["a1", "a2"]),
	).toEqual([
		{
			code: "coverage_duplicate",
			groupIndex: 1,
			detail: "a2 is also in group 0",
		},
	]);
});

test("validateAliases requires the draft exactly for a canonical disposition", () => {
	expect(
		codes(
			validateAliases(
				[{ members: ["a1"], disposition: "canonical", canonical: null }],
				["a1"],
			),
		),
	).toEqual(["canonical_mismatch"]);
	expect(
		codes(
			validateAliases(
				[
					{
						members: ["a1"],
						disposition: "unusable",
						canonical: { claims: [{ support: ["a1"] }] },
					},
				],
				["a1"],
			),
		),
	).toEqual(["canonical_mismatch"]);
});

test("validateRelations needs two different existing groups", () => {
	const rel = (a: number, b: number) => ({
		a,
		b,
		kind: "conflict" as const,
		note: "",
	});
	expect(validateRelations([rel(0, 1)], 2)).toEqual([]);
	expect(codes(validateRelations([rel(0, 2)], 2))).toEqual(["relation_index"]);
	expect(codes(validateRelations([rel(1, 1)], 2))).toEqual(["relation_index"]);
});

// ---- checkNovelty ----------------------------------------------------------------------

const SUPPORT = [
	"Before changing the database schema in production, take a backup and run the migration inside a transaction.",
	"The migration must finish within 30 seconds and call retryJob() on failure.",
];

test("checkNovelty accepts a claim made of the supports' own words", () => {
	const r = checkNovelty(
		"Take a backup before changing the production database schema.",
		SUPPORT,
	);
	expect(r.ok).toBe(true);
	expect(r.ratio).toBeGreaterThanOrEqual(0.6);
	expect(r.unsupportedLiterals).toEqual([]);
});

test("checkNovelty rejects a claim with mostly new words", () => {
	const r = checkNovelty(
		"Always prefer horizontal scaling with sharded replicas.",
		SUPPORT,
	);
	expect(r.ok).toBe(false);
	expect(r.ratio).toBeLessThan(0.6);
});

test("checkNovelty allows a number with a unit only when a support has the same string", () => {
	expect(
		checkNovelty("The migration must finish within 30 seconds.", SUPPORT).ok,
	).toBe(true);
	const r = checkNovelty(
		"The migration must finish within 60 seconds.",
		SUPPORT,
	);
	expect(r.ok).toBe(false);
	expect(r.unsupportedLiterals).toEqual(["60 seconds"]);
	// a number that is not in any support at all
	expect(
		checkNovelty("The migration retries 5 times.", SUPPORT).unsupportedLiterals,
	).toEqual(["5 times"]);
});

test("checkNovelty checks identifiers and code spans", () => {
	expect(
		checkNovelty("Call retryJob() when the migration fails.", SUPPORT)
			.unsupportedLiterals,
	).toEqual([]);
	expect(
		checkNovelty("Call `rollbackAll` when the migration fails.", SUPPORT)
			.unsupportedLiterals,
	).toEqual(["rollbackAll"]);
	expect(
		checkNovelty("Set MAX_RETRY_COUNT before the migration.", SUPPORT)
			.unsupportedLiterals,
	).toEqual(["MAX_RETRY_COUNT"]);
	// plain hyphenated words and abbreviations are not identifiers
	expect(
		checkNovelty("A read-only backup, e.g. before the migration.", SUPPORT)
			.unsupportedLiterals,
	).toEqual([]);
});

test("checkNovelty works on Japanese claims", () => {
	const support = [
		"本番のデータベースを変更する前に、必ずバックアップを取ること。失敗時は5分以内に切り戻す。",
	];
	expect(
		checkNovelty(
			"本番のデータベースを変更する前にバックアップを取る。",
			support,
		).ok,
	).toBe(true);
	expect(
		checkNovelty("失敗時は10分以内に切り戻す。", support).unsupportedLiterals,
	).toEqual(["10分"]);
	expect(
		checkNovelty("画像の圧縮率を上げるためにWebPへ変換する。", support).ok,
	).toBe(false);
});

// ---- lintGeneralization ----------------------------------------------------------------

const draft = (over: Partial<CanonicalDraft> = {}): CanonicalDraft => ({
	type: "rule",
	polarity: "positive",
	title: "スキーマ変更の前にバックアップを取る",
	situation: "本番DBのスキーマを変更する直前",
	guidance: "変更の前にバックアップを取り、移行はトランザクションで行う。",
	rationale: "戻せない変更だから。",
	appliesWhen: ["本番環境"],
	notAppliesWhen: [],
	steps: ["バックアップを取る", "移行を実行する"],
	exceptions: [],
	claims: [{ text: "バックアップを取る。", support: ["a1"] }],
	...over,
});

test("lintGeneralization passes a general draft", () => {
	expect(lintGeneralization(draft(), terms)).toEqual([]);
});

test("lintGeneralization reports repo names, paths and ports with the field", () => {
	const v = lintGeneralization(
		draft({
			title: "NightWorkers のバックアップ",
			guidance: "/Users/a/Code/x/run.sh を実行する",
			steps: ["ok", "edit api/domains/x/index.ts"],
			exceptions: ["localhost:3000 では不要"],
		}),
		terms,
	);
	expect(v).toEqual([
		{ code: "repo_term", field: "title", match: "nightworkers" },
		{
			code: "absolute_path",
			field: "guidance",
			match: "/Users/a/Code/x/run.sh",
		},
		{
			code: "relative_path",
			field: "steps[1]",
			match: "api/domains/x/index.ts",
		},
		{ code: "port", field: "exceptions[0]", match: "localhost:3000" },
	]);
});

// ---- checkPolarity ---------------------------------------------------------------------

test("checkPolarity follows the majority of the supports", () => {
	const s = (...p: ("positive" | "negative")[]) =>
		p.map((polarity) => ({ polarity }));
	expect(
		checkPolarity(
			{ polarity: "positive" },
			s("positive", "positive", "negative"),
		),
	).toEqual({ ok: true, majority: "positive", tie: false });
	expect(
		checkPolarity(
			{ polarity: "negative" },
			s("positive", "positive", "negative"),
		),
	).toMatchObject({ ok: false, majority: "positive" });
	expect(checkPolarity({ polarity: "negative" }, s("negative"))).toMatchObject({
		ok: true,
	});
});

test("checkPolarity prefers negative on a tie and flags it", () => {
	const tie = [
		{ polarity: "positive" as const },
		{ polarity: "negative" as const },
	];
	expect(checkPolarity({ polarity: "negative" }, tie)).toEqual({
		ok: true,
		majority: "negative",
		tie: true,
	});
	expect(checkPolarity({ polarity: "positive" }, tie)).toEqual({
		ok: false,
		majority: "negative",
		tie: true,
	});
});

// ---- negation (R1-9) -------------------------------------------------------------------

test("hasNegation sees English and Japanese negation, and not a cancelled one", () => {
	for (const t of [
		"Do not run migrations outside a transaction.",
		"Never retry on 4xx.",
		"It doesn't work without a lock.",
		"Avoid long transactions.",
		"本番では実行しない。",
		"バックアップなしで変更しないこと",
		"直接の編集は禁止する。",
	])
		expect(hasNegation(t)).toBe(true);
	for (const t of [
		"Run migrations inside a transaction.",
		"Never skip the backup.",
		"Do not forget to take a backup.",
		"バックアップを省略しない。",
		"Take a note of the retries.",
		"本番の前にバックアップを取る。",
	])
		expect(hasNegation(t)).toBe(false);
});

test("checkNegation rejects a claim whose negation differs from its supporting sentence", () => {
	const support = [
		"Do not run migrations outside a transaction on production databases.\nTake a backup first.",
	];
	expect(
		checkNegation(
			"Run migrations outside a transaction on production databases.",
			support,
		).ok,
	).toBe(false);
	expect(
		checkNegation(
			"Do not run migrations outside a transaction on production.",
			support,
		).ok,
	).toBe(true);
	// and the other way round
	expect(
		checkNegation("Never take a backup first.", ["Take a backup first."]).ok,
	).toBe(false);
	expect(
		checkNegation("本番で直接編集する。", ["本番では直接編集しない。"]).ok,
	).toBe(false);
	expect(
		checkNegation("本番では直接編集しない。", ["本番では直接編集しない。"]).ok,
	).toBe(true);
});

test("checkNegation does not judge a claim that has no close sentence, or one that restates a cancelled negation", () => {
	const support = [
		"Never skip the backup before a schema change. Do not drop columns in the same release.",
	];
	// the claim draws on two sentences: neither covers half of it
	expect(
		checkNegation(
			"Keep the backup and drop columns in a later release.",
			support,
		).ok,
	).toBe(true);
	// "never skip" is an affirmative instruction
	expect(
		checkNegation("Take the backup before a schema change.", support).ok,
	).toBe(true);
	// a negation elsewhere in a long support does not count against a plain claim
	expect(
		checkNegation("Drop columns in a separate release.", [
			"Drop columns in a separate release. Do not rename tables.",
			"Use the standard tooling.",
		]).ok,
	).toBe(true);
	expect(checkNegation("ok", ["not ok"]).ok).toBe(true);
});

test("lintFacets reports repo names, paths and ports in facet values with their place", () => {
	const v = lintFacets(
		{
			technologies: ["sqlite", "nightworkers"],
			note: "see src/app/run.ts",
			owner: "team",
			nested: { port: "localhost:3000" },
		},
		terms,
	);
	expect(v.map((x) => [x.code, x.field])).toEqual([
		["repo_term", "facets.technologies[1]"],
		["relative_path", "facets.note[0]"],
		["port", "facets.nested[0]"],
	]);
});
