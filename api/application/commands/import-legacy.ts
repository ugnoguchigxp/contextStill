import { runLegacyImport, type LegacyTable } from "../../domains/legacy";
import {
	exitWith,
	intOption,
	parseArgs,
	runCommand,
	UsageError,
} from "./shared";

const OPTIONS = {
	snapshot: "value",
	"dry-run": "flag",
	only: "value",
	batch: "value",
} as const;

const TABLES: readonly LegacyTable[] = [
	"vibe_memories",
	"sources",
	"source_fragments",
	"episode_cards",
	"knowledge_items",
	"knowledge_usage_events",
	"knowledge_items_vec_fallback",
];

function parse(argv: string[]) {
	const args = parseArgs(argv, OPTIONS);
	const snapshotPath = args.values.get("snapshot");
	if (!snapshotPath) throw new UsageError("--snapshot <path> is required");
	const only = args.values
		.get("only")
		?.split(",")
		.map((name) => name.trim())
		.filter(Boolean);
	for (const name of only ?? [])
		if (!TABLES.includes(name as LegacyTable))
			throw new UsageError(`unknown table: ${name}`);
	return {
		snapshotPath,
		dryRun: args.flags.has("dry-run"),
		only: only as LegacyTable[] | undefined,
		batchSize: intOption(args, "batch", 500),
	};
}

export const importLegacy = (argv: string[]) =>
	runCommand(
		"import:legacy",
		argv,
		(runtime) => {
			const args = parse(argv);
			return runLegacyImport(
				{
					store: runtime.store,
					dbPath: runtime.config.dbPath,
					now: runtime.now,
					log: (line) => console.error(line),
				},
				{
					snapshotPath: args.snapshotPath,
					dryRun: args.dryRun,
					...(args.only ? { only: args.only } : {}),
					batchSize: args.batchSize,
				},
			);
		},
		{ validate: parse },
	);

if (import.meta.main) exitWith(importLegacy(process.argv.slice(2)));
