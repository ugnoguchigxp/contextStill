import { verifyLegacyVectors } from "../../domains/indexing";
import {
	EXIT_FAILURE,
	EXIT_OK,
	exitWith,
	intOption,
	parseArgs,
	runCommand,
	unitIntervalOption,
} from "./shared";
import type { Runtime } from "../runtime";

const OPTIONS = {
	sample: "value",
	min: "value",
	mean: "value",
	"dry-run": "flag",
} as const;

function parse(argv: string[]) {
	const args = parseArgs(argv, OPTIONS);
	return {
		sampleSize: intOption(args, "sample", 32),
		thresholdMin: unitIntervalOption(args, "min", 0.995),
		thresholdMean: unitIntervalOption(args, "mean", 0.999),
		dryRun: args.flags.has("dry-run"),
	};
}

export const indexingDeps = (runtime: Runtime) => ({
	store: runtime.store,
	larm: runtime.larm,
	spaceKey: runtime.spaceKey,
	now: runtime.now,
	log: (line: string) => console.error(line),
	sleep: (ms: number) =>
		new Promise<void>((resolve) => setTimeout(resolve, ms)),
});

export const vectorsVerifyLegacy = (argv: string[]) =>
	runCommand(
		"vectors:verify-legacy",
		argv,
		(runtime) => verifyLegacyVectors(indexingDeps(runtime), parse(argv)),
		{
			validate: parse,
			// A failed verification is recorded (the vectors become mismatch), but exits 1.
			exitCode: (report) => (report.passed ? EXIT_OK : EXIT_FAILURE),
		},
	);

if (import.meta.main) exitWith(vectorsVerifyLegacy(process.argv.slice(2)));
