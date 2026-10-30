import { resolve } from "node:path";
import { ensureApiToken, ensureMcpToken } from "../infrastructure/auth-config";
import { getLogger } from "../infrastructure/logger";
import { createApp } from "./app";
import { resolveConfig } from "./config";
import { openRuntime } from "./runtime";

const log = getLogger("server");

/** The only `Bun.serve` call of the product. Never imported by tests. */
async function main() {
	const config = resolveConfig(process.env, resolve(import.meta.dir, "../.."));
	const runtime = await openRuntime(config);
	const tokenEnv = {
		CONTEXT_STILL_API_TOKEN: config.apiToken,
		CONTEXT_STILL_MCP_TOKEN: config.mcpToken,
		CONTEXT_STILL_KEY_DIR: config.keyDir,
	};
	const app = createApp(runtime, {
		api: ensureApiToken(tokenEnv, config.dbPath),
		mcp: ensureMcpToken(tokenEnv, config.dbPath),
	});
	const server = Bun.serve({
		hostname: config.host,
		port: config.port,
		fetch: app.fetch,
	});
	log.info("server.listening", { host: config.host, port: config.port });
	let closing = false;
	const shutdown = async () => {
		if (closing) return;
		closing = true;
		await server.stop();
		await runtime.close();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
	const code = error instanceof Error ? error.message : "unknown";
	console.error(`server failed: ${code}`);
	process.exit(1);
});
