import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { evalCaseSchema, runEvaluation } from "../index";
import { parseEvalSet } from "../service/load-set";

const SET = join(
	import.meta.dir,
	"../../../../eval/sets/coding-known-item-v1.jsonl",
);

const SNAPSHOT =
	"/Users/y.noguchi/Code/contextStill-db-backup-20261029/context-still-core.sqlite";

/** The first `n`-character run of `a` (case and whitespace folded) that `b` also contains. */
function sharedRun(a: string, b: string, n: number): string | null {
	const fold = (value: string) => [...value.toLowerCase().replace(/\s+/g, "")];
	const chars = fold(a);
	const haystack = fold(b).join("");
	for (let i = 0; i + n <= chars.length; i++) {
		const run = chars.slice(i, i + n).join("");
		if (haystack.includes(run)) return run;
	}
	return null;
}

test("sharedRun finds the shortest-run overlap the paraphrase rule forbids", () => {
	expect(sharedRun("abcdef", "xxCDExx", 3)).toBe("cde");
	expect(sharedRun("abcdef", "xxCDxEx", 3)).toBeNull();
	expect(sharedRun("共通 の部品", "これは共通の部品だ", 4)).toBe("共通の部");
	expect(sharedRun("短い", "短い", 3)).toBeNull();
});

test("eval set v1: every line passes the schema and the plan's composition", () => {
	const text = readFileSync(SET, "utf8");
	const cases = parseEvalSet(text);
	expect(cases).toHaveLength(60);
	expect(new Set(cases.map((c) => c.id)).size).toBe(60);

	const styles = { paraphrase: 0, question: 0, keyword: 0 };
	for (const c of cases) {
		styles[c.style] += 1;
		expect(c.labelSource).toBe("agent-draft");
		expect(c.spaces).toEqual(["coding"]);
		expect(c.kinds).toEqual(["knowledge"]);
		const refs = c.relevant.map((r) => r.ref);
		expect(new Set(refs).size).toBe(refs.length);
		expect(c.relevant.filter((r) => r.grade === 3)).toHaveLength(1);
		// only refs and the query: no knowledge text, paths or UUIDs in the query
		expect(c.query).not.toMatch(/[\\/]/);
		expect(c.query).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
		expect((c.note ?? "").length).toBeLessThan(120);
	}
	expect(styles).toEqual({ paraphrase: 30, question: 20, keyword: 10 });

	// one grade:3 row per case, never reused by another case
	const primaries = cases.map(
		(c) => c.relevant.find((r) => r.grade === 3)?.ref,
	);
	expect(new Set(primaries).size).toBe(60);
	// no repo names, paths, e-mail addresses or key-looking strings in a query
	for (const c of cases) {
		expect(c.query).not.toMatch(
			/@|https?:|[A-Za-z0-9+_-]{32,}|\.(ts|md|json)\b/,
		);
		expect(c.query.length).toBeLessThanOrEqual(200);
	}

	// each line is exactly what the schema yields (no stray fields)
	for (const line of text.split("\n").filter(Boolean))
		expect(evalCaseSchema.safeParse(JSON.parse(line)).success).toBe(true);
});

test("parseEvalSet names the offending line", () => {
	const ok = JSON.stringify({
		id: "a-1",
		query: "q",
		spaces: ["coding"],
		relevant: [
			{
				ref: "legacy:knowledge_items:0c6a8f0e-1d0b-4c8e-a7b1-2f3e4d5c6b7a",
				grade: 3,
			},
		],
		labelSource: "owner",
		style: "keyword",
	});
	expect(parseEvalSet(`${ok}\n\n${ok.replace("a-1", "a-2")}\n`)).toHaveLength(
		2,
	);
	expect(() => parseEvalSet(`${ok}\nnot json`)).toThrow(
		"eval_set_invalid_json: line 2",
	);
	expect(() => parseEvalSet(`${ok}\n{"id":"b"}`)).toThrow(
		"eval_set_invalid_case: line 2",
	);
	expect(() => parseEvalSet(`${ok}\n${ok}`)).toThrow(
		"eval_set_duplicate_id: line 2",
	);
});

test("runEvaluation rejects k outside 1..50", async () => {
	await expect(runEvaluation({} as never, { k: 0 } as never)).rejects.toThrow(
		"eval_invalid_k",
	);
	await expect(runEvaluation({} as never, { k: 51 } as never)).rejects.toThrow(
		"eval_invalid_k",
	);
});

test.skipIf(!existsSync(SNAPSHOT))(
	"eval set v1 against the snapshot: relevant rows are searchable, and paraphrases do not copy the title or the body",
	() => {
		const db = new Database(`file:${SNAPSHOT}?mode=ro&immutable=1`, {
			readonly: true,
		});
		try {
			const row = db.query<
				{
					status: string;
					scope: string;
					repo_key: string;
					repo_path: string;
					title: string;
					body: string;
				},
				[string]
			>(
				`SELECT status, scope, coalesce(repo_key, '') AS repo_key,
				        coalesce(repo_path, '') AS repo_path, title, body
				 FROM knowledge_items WHERE id = ?`,
			);
			for (const c of parseEvalSet(readFileSync(SET, "utf8"))) {
				for (const { ref, grade } of c.relevant) {
					const found = row.get(ref.split(":")[2]!);
					expect(found, `${c.id} ${ref}`).not.toBeNull();
					// v2 scope rule: global, or repo without repo_key and repo_path
					expect(found!.status, `${c.id} ${ref}`).toBe("active");
					expect(
						found!.scope === "global" ||
							(found!.scope === "repo" &&
								found!.repo_key === "" &&
								found!.repo_path === ""),
						`${c.id} ${ref} grade ${grade} is repo scoped`,
					).toBe(true);
				}
				const primary = row.get(
					c.relevant.find((r) => r.grade === 3)!.ref.split(":")[2]!,
				)!;
				if (c.style === "paraphrase")
					expect(
						sharedRun(c.query, primary.title, 3),
						`${c.id} shares a run with the title`,
					).toBeNull();
				if (c.style !== "keyword")
					expect(
						sharedRun(c.query, primary.body, 12),
						`${c.id} shares a run with the body`,
					).toBeNull();
			}
		} finally {
			db.close();
		}
	},
);
