import { chmod, writeFile } from "node:fs/promises";
import { runDistillCli } from "../../domains/distill";
import { readApiToken } from "../../infrastructure/auth-config";
import { ConfigError, resolveConfig } from "../config";
import { REPO_ROOT } from "./shared";

/**
 * `bun run distill <subcommand>`: a client of the running backend's /api/distill. It never opens
 * the database, so it works while the backend owns the writer lock (and needs the backend up).
 */
export async function distill(argv: string[]): Promise<number> {
	let config: ReturnType<typeof resolveConfig>;
	try {
		config = resolveConfig(process.env, REPO_ROOT);
	} catch (error) {
		if (!(error instanceof ConfigError)) throw error;
		console.error(`distill: ${error.message}`);
		return 2;
	}
	let token: string;
	try {
		token = readApiToken(
			{
				CONTEXT_STILL_API_TOKEN: config.apiToken,
				CONTEXT_STILL_KEY_DIR: config.keyDir,
			},
			config.dbPath,
		);
	} catch {
		// The message carries the token path; the code alone is enough here.
		console.error("distill: api_token_not_found");
		return 1;
	}
	const host = config.host.includes(":") ? `[${config.host}]` : config.host;
	return runDistillCli(argv, {
		baseUrl: `http://${host}:${config.port}`,
		token,
		fetch: ((input, init) => globalThis.fetch(input, init)) as typeof fetch,
		readText: (path) => Bun.file(path).text(),
		// Bun.write ignores a mode; the calibration sample (knowledge text) is written 0600.
		writeText: async (path, text, mode) => {
			await writeFile(path, text, mode === undefined ? {} : { mode });
			if (mode !== undefined) await chmod(path, mode);
		},
		stdout: (line) => console.log(line),
		stderr: (line) => console.error(line),
	});
}

if (import.meta.main)
	void distill(process.argv.slice(2)).then((code) => process.exit(code));
