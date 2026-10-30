import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { runEvaluation, type EvalSystem } from "../../domains/evaluation";
import type { SearchLane } from "../../domains/search";
import {
	exitWith,
	intOption,
	parseArgs,
	REPO_ROOT,
	runCommand,
	UsageError,
} from "./shared";

const OPTIONS = {
	set: "value",
	systems: "value",
	lanes: "value",
	k: "value",
	out: "value",
	judge: "flag",
} as const;

const SYSTEMS: readonly EvalSystem[] = [
	"legacy-lexical",
	"legacy-query-first",
	"v2-atom-baseline",
	"v2-hybrid",
];
const LANES: readonly SearchLane[] = ["fts", "short", "vector"];
/** Without LARM (nightly runs) the vector lane is left out; add it with --lanes fts,short,vector. */
const DEFAULT_LANES: readonly SearchLane[] = ["fts", "short"];

function list<T extends string>(
	raw: string | undefined,
	allowed: readonly T[],
	fallback: readonly T[],
	name: string,
): T[] {
	if (raw === undefined) return [...fallback];
	const items = raw
		.split(",")
		.map((x) => x.trim())
		.filter(Boolean);
	if (items.length === 0) throw new UsageError(`--${name} is empty`);
	for (const item of items)
		if (!allowed.includes(item as T))
			throw new UsageError(`unknown ${name}: ${item}`);
	return items as T[];
}

function parse(argv: string[], now: Date = new Date()) {
	const args = parseArgs(argv, OPTIONS);
	const setPath = args.values.get("set");
	if (!setPath) throw new UsageError("--set <path> is required");
	const stamp = now.toISOString().replace(/[-:.]/g, "");
	const out =
		args.values.get("out") ?? join("data", "eval", "reports", `${stamp}.json`);
	return {
		setPath: isAbsolute(setPath) ? setPath : join(REPO_ROOT, setPath),
		systems: list(args.values.get("systems"), SYSTEMS, SYSTEMS, "systems"),
		lanes: list(args.values.get("lanes"), LANES, DEFAULT_LANES, "lanes"),
		k: intOption(args, "k", 10),
		outPath: isAbsolute(out) ? out : join(REPO_ROOT, out),
		/** Judges unjudged canonical pairs in the top k with the distill LLM (needs LARM). */
		judge: args.flags.has("judge"),
	};
}

export const evalSearch = (argv: string[]) =>
	runCommand(
		"eval:search",
		argv,
		async (runtime) => {
			const args = parse(argv, runtime.now());
			mkdirSync(dirname(args.outPath), { recursive: true });
			const report = await runEvaluation(
				{
					store: runtime.store,
					search: runtime.search,
					now: runtime.now,
					log: (line) => console.error(line),
				},
				args,
				args.judge
					? {
							judgePairs: (pairs, signal) =>
								runtime.distill.judgePairs(pairs, signal),
						}
					: {},
			);
			// runEvaluation owns the file; this only guarantees one exists at --out.
			if (!existsSync(args.outPath))
				writeFileSync(args.outPath, `${JSON.stringify(report, null, 2)}\n`);
			return report;
		},
		{ validate: (argv) => void parse(argv) },
	);

if (import.meta.main) exitWith(evalSearch(process.argv.slice(2)));
