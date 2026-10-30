import { EmbedAbortedError, embedMissing } from "../../domains/indexing";
import type { VectorOwnerKind } from "../../domains/vectors";
import {
	EXIT_FAILURE,
	EXIT_OK,
	exitWith,
	intOption,
	parseArgs,
	runCommand,
	UsageError,
} from "./shared";
import { indexingDeps } from "./vectors-verify-legacy";

const OPTIONS = {
	owner: "value",
	all: "flag",
	batch: "value",
	limit: "value",
	"dry-run": "flag",
} as const;

function parse(argv: string[]) {
	const args = parseArgs(argv, OPTIONS);
	const owner = args.values.get("owner");
	if (owner !== "knowledge" && owner !== "episode")
		throw new UsageError("--owner knowledge|episode is required");
	return {
		owner: owner as VectorOwnerKind,
		mode: args.flags.has("all") ? ("all" as const) : ("missing" as const),
		batchSize: intOption(args, "batch", 16),
		...(args.values.has("limit") ? { limit: intOption(args, "limit", 1) } : {}),
		dryRun: args.flags.has("dry-run"),
	};
}

export const vectorsEmbed = (argv: string[]) =>
	runCommand(
		"vectors:embed",
		argv,
		async (runtime) => {
			try {
				return await embedMissing(indexingDeps(runtime), parse(argv));
			} catch (error) {
				// The reason holds only LARM error codes and counts; batches before it are kept.
				if (error instanceof EmbedAbortedError)
					console.error(
						`vectors:embed: embed_aborted (${error.reason}); embedded=${error.embedded} failed=${error.failed}`,
					);
				throw error;
			}
		},
		{
			validate: parse,
			// Batches that failed are not embedded; a partial run must not look like success.
			exitCode: (report) => (report.failed > 0 ? EXIT_FAILURE : EXIT_OK),
		},
	);

if (import.meta.main) exitWith(vectorsEmbed(process.argv.slice(2)));
