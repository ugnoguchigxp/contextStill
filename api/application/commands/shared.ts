import { resolve } from "node:path";
import { WriterOwnedError } from "../../infrastructure/sqlite";
import { ConfigError, resolveConfig } from "../config";
import { errorCodeOf } from "../error-status";
import { openRuntime, type Runtime } from "../runtime";

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;
export const EXIT_WRITER_OWNED = 3;

export const REPO_ROOT = resolve(import.meta.dir, "../../..");

export class UsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UsageError";
	}
}

export interface OptionSpec {
	/** `flag` takes no value; `value` takes exactly one. */
	[name: string]: "flag" | "value";
}

export interface ParsedArgs {
	flags: Set<string>;
	values: Map<string, string>;
}

/**
 * Strict `--name [value]` parsing: unknown options, missing values and stray positionals are
 * usage errors. A lone `--` is skipped (bun passes it through from `bun run x -- --a b`).
 */
export function parseArgs(argv: string[], spec: OptionSpec): ParsedArgs {
	const flags = new Set<string>();
	const values = new Map<string, string>();
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--") continue;
		if (!arg.startsWith("--"))
			throw new UsageError(`unexpected argument: ${arg}`);
		const name = arg.slice(2);
		const kind = spec[name];
		if (kind === undefined) throw new UsageError(`unknown option: --${name}`);
		if (kind === "flag") flags.add(name);
		else {
			const value = argv[++i];
			if (value === undefined || value.startsWith("--"))
				throw new UsageError(`missing value for --${name}`);
			values.set(name, value);
		}
	}
	return { flags, values };
}

/** A positive integer option, or the default. */
export function intOption(
	args: ParsedArgs,
	name: string,
	fallback: number,
): number {
	const raw = args.values.get(name);
	if (raw === undefined) return fallback;
	if (!/^\d{1,9}$/.test(raw) || Number(raw) < 1)
		throw new UsageError(`--${name} must be a positive integer`);
	return Number(raw);
}

export function numberOption(
	args: ParsedArgs,
	name: string,
	fallback: number,
): number {
	const raw = args.values.get(name);
	if (raw === undefined) return fallback;
	// Number("") and Number("  ") are 0, so a blank value is refused explicitly.
	const value = raw.trim() === "" ? Number.NaN : Number(raw);
	if (!Number.isFinite(value))
		throw new UsageError(`--${name} must be a number`);
	return value;
}

/** A number in (0, 1], or the default: cosine thresholds and similar ratios. */
export function unitIntervalOption(
	args: ParsedArgs,
	name: string,
	fallback: number,
): number {
	const value = numberOption(args, name, fallback);
	if (!(value > 0 && value <= 1))
		throw new UsageError(`--${name} must be in (0, 1]`);
	return value;
}

export function exitCodeOf(error: unknown): number {
	if (error instanceof UsageError) return EXIT_USAGE;
	if (error instanceof WriterOwnedError) return EXIT_WRITER_OWNED;
	return EXIT_FAILURE;
}

/**
 * The thin entry of every maintenance command: parse, open the runtime (which takes the OS
 * writer lock), run, print the report as JSON on stdout, close. Exit codes: 0 success,
 * 1 failure (including a report that `exitCode` judges failed), 2 bad arguments,
 * 3 database_writer_owned.
 */
export async function runCommand<R>(
	name: string,
	argv: string[],
	body: (runtime: Runtime, argv: string[]) => Promise<R>,
	options: {
		/** Checked before the database is opened, so a bad argument never takes the lock. */
		validate?: (argv: string[]) => void;
		env?: Record<string, string | undefined>;
		/** The exit code of a completed run; the report is printed either way. Default 0. */
		exitCode?: (report: R) => number;
	} = {},
): Promise<number> {
	let runtime: Runtime | undefined;
	try {
		options.validate?.(argv);
		const config = resolveConfig(options.env ?? process.env, REPO_ROOT);
		runtime = await openRuntime(config);
		const report = await body(runtime, argv);
		console.log(JSON.stringify(report, null, 2));
		return options.exitCode?.(report) ?? EXIT_OK;
	} catch (error) {
		const code =
			error instanceof UsageError
				? error.message
				: error instanceof ConfigError || error instanceof WriterOwnedError
					? error.message
					: (errorCodeOf(error) ?? "command_failed");
		console.error(`${name}: ${code}`);
		return exitCodeOf(error);
	} finally {
		await runtime?.close();
	}
}

/** `bun api/application/commands/<x>.ts`: runs the command and exits with its code. */
export function exitWith(promise: Promise<number>): void {
	void promise.then((code) => process.exit(code));
}
