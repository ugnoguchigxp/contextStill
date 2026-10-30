/**
 * The body of `bun run distill` (5.8): an API client for the backend's /api/distill/*. It never
 * opens the database. The thin entry (api/application/commands/distill.ts) builds `DistillCliDeps`
 * from the configuration (`http://host:port`, the API token), `fetch` and the file system, calls
 * `runDistillCli(process.argv.slice(2), deps)` and exits with the returned code.
 *
 *   run STAGE [--limit N] [--dry-run] [--allow-unverified]   POST /api/distill/runs
 *   status [RUN_ID]                                           GET /api/distill/status, /runs/:id
 *   calibration-export PATH [--n N]                           GET /api/distill/calibration/sample
 *   calibration-import PATH                                   PUT /api/distill/calibration
 *   reviews [--state open|resolved|dismissed]                 GET /api/distill/reviews
 *   resolve ID JSON                                           POST /api/distill/reviews/:id/resolve
 *   audit                                                     GET /api/distill/audit
 */
import { DISTILL_STAGES } from "../contracts";

export const EXIT_OK = 0;
/** The backend answered with an error (including 401), or `audit` found violations. */
export const EXIT_FAILURE = 1;
/** Bad arguments; nothing was sent. */
export const EXIT_USAGE = 2;
/** The backend could not be reached. (3 is `database_writer_owned` of the maintenance commands.) */
export const EXIT_UNREACHABLE = 4;

export interface DistillCliDeps {
	/** `http://host:port` of the backend. */
	baseUrl: string;
	/** The API token; sent as a bearer and never printed. */
	token: string;
	fetch: typeof fetch;
	readText: (path: string) => Promise<string>;
	/** `mode` is the file mode of a new file (the sample carries the text of the knowledge: 0600). */
	writeText: (path: string, text: string, mode?: number) => Promise<void>;
	/** Milliseconds before a request is given up; 60 000 by default (150 000 for `resolve`). */
	timeoutMs?: number;
	/** One line of the result (JSON). */
	stdout: (line: string) => void;
	/** One line of an error. */
	stderr: (line: string) => void;
}

/** A request is given up after this long (the model-backed `resolve` gets more). */
const DEFAULT_TIMEOUT_MS = 60_000;
const RESOLVE_TIMEOUT_MS = 150_000;
/** The sample is written for the owner alone. */
const PRIVATE_FILE_MODE = 0o600;

class UsageError extends Error {}

class ApiError extends Error {
	constructor(
		public status: number,
		public code: string,
	) {
		super(code);
	}
}

interface Parsed {
	positionals: string[];
	flags: Set<string>;
	values: Map<string, string>;
}

function parse(
	argv: string[],
	spec: Record<string, "flag" | "value">,
	positionals: number | [number, number],
): Parsed {
	const out: Parsed = { positionals: [], flags: new Set(), values: new Map() };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--") continue;
		if (!arg.startsWith("--")) {
			out.positionals.push(arg);
			continue;
		}
		const name = arg.slice(2);
		const kind = spec[name];
		if (kind === undefined) throw new UsageError(`unknown option: --${name}`);
		if (kind === "flag") out.flags.add(name);
		else {
			const value = argv[++i];
			if (value === undefined || value.startsWith("--"))
				throw new UsageError(`missing value for --${name}`);
			out.values.set(name, value);
		}
	}
	const [min, max] = Array.isArray(positionals)
		? positionals
		: [positionals, positionals];
	if (out.positionals.length < min || out.positionals.length > max)
		throw new UsageError("wrong number of arguments");
	return out;
}

function positiveInt(args: Parsed, name: string): number | undefined {
	const raw = args.values.get(name);
	if (raw === undefined) return undefined;
	if (!/^\d{1,9}$/.test(raw) || Number(raw) < 1)
		throw new UsageError(`--${name} must be a positive integer`);
	return Number(raw);
}

export async function runDistillCli(
	argv: string[],
	deps: DistillCliDeps,
): Promise<number> {
	const call = async (
		method: "GET" | "POST" | "PUT",
		path: string,
		body?: unknown,
		timeoutMs = DEFAULT_TIMEOUT_MS,
	): Promise<unknown> => {
		let res: Response;
		try {
			res = await deps.fetch(new URL(path, deps.baseUrl).toString(), {
				method,
				headers: {
					authorization: `Bearer ${deps.token}`,
					...(body !== undefined ? { "content-type": "application/json" } : {}),
				},
				...(body !== undefined ? { body: JSON.stringify(body) } : {}),
				signal: AbortSignal.timeout(deps.timeoutMs ?? timeoutMs),
			});
		} catch (error) {
			// The reason may carry the URL; only the fact is reported.
			throw new ApiError(
				0,
				error instanceof Error && error.name === "TimeoutError"
					? "backend_timeout"
					: "backend_unreachable",
			);
		}
		if (res.status === 204) return null;
		let json: unknown = null;
		try {
			json = await res.json();
		} catch (error) {
			// The body did not arrive in time: the same as no answer at all.
			if (error instanceof Error && error.name === "TimeoutError")
				throw new ApiError(0, "backend_timeout");
			// not JSON: handled by status below
		}
		if (!res.ok) {
			const code =
				json &&
				typeof json === "object" &&
				typeof (json as { error?: unknown }).error === "string"
					? (json as { error: string }).error
					: `http_${res.status}`;
			throw new ApiError(
				res.status,
				/^[a-z][a-z0-9_]*$/.test(code) ? code : `http_${res.status}`,
			);
		}
		return json;
	};
	const print = (value: unknown) => deps.stdout(JSON.stringify(value, null, 2));

	try {
		const [command, ...rest] = argv.filter((a, i) => !(a === "--" && i === 0));
		switch (command) {
			case "run": {
				const args = parse(
					rest,
					{ limit: "value", "dry-run": "flag", "allow-unverified": "flag" },
					1,
				);
				const stage = args.positionals[0]!;
				if (!(DISTILL_STAGES as readonly string[]).includes(stage))
					throw new UsageError(`unknown stage: ${stage}`);
				const limit = positiveInt(args, "limit");
				print(
					await call("POST", "/api/distill/runs", {
						stage,
						...(limit !== undefined ? { limit } : {}),
						dryRun: args.flags.has("dry-run"),
						...(args.flags.has("allow-unverified")
							? { allowUnverified: true }
							: {}),
					}),
				);
				return EXIT_OK;
			}
			case "status": {
				const args = parse(rest, {}, [0, 1]);
				const id = args.positionals[0];
				print(
					await call(
						"GET",
						id === undefined
							? "/api/distill/status"
							: `/api/distill/runs/${encodeURIComponent(id)}`,
					),
				);
				return EXIT_OK;
			}
			case "calibration-export": {
				const args = parse(rest, { n: "value" }, 1);
				const n = positiveInt(args, "n") ?? 300;
				const sample = (await call(
					"GET",
					`/api/distill/calibration/sample?n=${n}`,
				)) as unknown[];
				await deps.writeText(
					args.positionals[0]!,
					`${JSON.stringify(sample, null, 2)}\n`,
					PRIVATE_FILE_MODE,
				);
				print({ written: args.positionals[0], pairs: sample.length });
				return EXIT_OK;
			}
			case "calibration-import": {
				const args = parse(rest, {}, 1);
				let data: unknown;
				try {
					data = JSON.parse(await deps.readText(args.positionals[0]!));
				} catch {
					throw new UsageError("the file is missing or is not JSON");
				}
				const labels = Array.isArray(data)
					? data
					: data && typeof data === "object"
						? (data as { labels?: unknown }).labels
						: undefined;
				if (!Array.isArray(labels))
					throw new UsageError(
						"the file must be a list of labels or {labels: [...]}",
					);
				print(await call("PUT", "/api/distill/calibration", { labels }));
				return EXIT_OK;
			}
			case "reviews": {
				const args = parse(rest, { state: "value" }, 0);
				const state = args.values.get("state") ?? "open";
				if (!["open", "resolved", "dismissed"].includes(state))
					throw new UsageError("--state must be open, resolved or dismissed");
				print(await call("GET", `/api/distill/reviews?state=${state}`));
				return EXIT_OK;
			}
			case "resolve": {
				const args = parse(rest, {}, 2);
				let decision: unknown;
				try {
					decision = JSON.parse(args.positionals[1]!);
				} catch {
					throw new UsageError(
						'the decision must be JSON, e.g. \'{"kind":"a_wins"}\'',
					);
				}
				if (
					!decision ||
					typeof decision !== "object" ||
					Array.isArray(decision)
				)
					throw new UsageError("the decision must be a JSON object");
				const id = args.positionals[0]!;
				await call(
					"POST",
					`/api/distill/reviews/${encodeURIComponent(id)}/resolve`,
					decision,
					RESOLVE_TIMEOUT_MS,
				);
				print({ resolved: id });
				return EXIT_OK;
			}
			case "audit": {
				parse(rest, {}, 0);
				const report = (await call("GET", "/api/distill/audit")) as {
					ok?: boolean;
				};
				print(report);
				return report.ok === true ? EXIT_OK : EXIT_FAILURE;
			}
			default:
				throw new UsageError(
					"usage: distill <run STAGE|status [RUN_ID]|calibration-export PATH|calibration-import PATH|reviews|resolve ID JSON|audit>",
				);
		}
	} catch (error) {
		if (error instanceof UsageError) {
			deps.stderr(`distill: ${error.message}`);
			return EXIT_USAGE;
		}
		if (error instanceof ApiError) {
			deps.stderr(`distill: ${error.code}`);
			return error.status === 0 ? EXIT_UNREACHABLE : EXIT_FAILURE;
		}
		deps.stderr("distill: command_failed");
		return EXIT_FAILURE;
	}
}
