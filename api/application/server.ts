import { resolve } from "node:path";
import { pruneFailedLlmCalls } from "../domains/distill";
import { ensureApiToken, ensureMcpToken } from "../infrastructure/auth-config";
import { getLogger } from "../infrastructure/logger";
import { createApp } from "./app";
import { resolveConfig } from "./config";
import { openRuntime, type Runtime } from "./runtime";

const log = getLogger("server");

const RETENTION_INTERVAL_MS = 60 * 60 * 1000;
/** Failed distill LLM calls are kept 30 days; the 'ok' ones stay for audit and reuse (9.4). */
const FAILED_LLM_CALL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Settled queue jobs and old failed LLM calls; run at start-up and hourly. */
async function prune(runtime: Runtime) {
	const at = runtime.now().getTime();
	try {
		const removed = await runtime.store.write((tx) => ({
			jobs: runtime.queue.pruneInTransaction(tx, at),
			llmCalls: pruneFailedLlmCalls(
				tx,
				new Date(at - FAILED_LLM_CALL_RETENTION_MS).toISOString(),
			),
		}));
		log.info("server.retention", removed);
	} catch (error) {
		log.warn("server.retention_failed", {
			reason: (error as { code?: string }).code ?? "unknown",
		});
	}
}

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
	// Jobs left running by an earlier backend go back to the queue, and runs no job can finish
	// are failed, before the runner starts and before any request can start a stage.
	await runtime.queue.recover();
	const orphanRuns = await runtime.distill.recoverRuns();
	if (orphanRuns > 0)
		log.warn("server.distill_runs_failed", { runs: orphanRuns });
	runtime.queue.start();
	await prune(runtime);
	const retention = setInterval(
		() => void prune(runtime),
		RETENTION_INTERVAL_MS,
	);
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
		clearInterval(retention);
		// Each step runs even when an earlier one fails, and the process always exits, so the
		// writer lock is released.
		let code = 0;
		for (const [step, run] of [
			["server", () => server.stop()],
			["queue", () => runtime.queue.close()],
			["runtime", () => runtime.close()],
		] as const)
			try {
				await run();
			} catch (error) {
				code = 1;
				log.warn("server.shutdown_step_failed", {
					step,
					reason: (error as { code?: string }).code ?? "unknown",
				});
			}
		process.exit(code);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
	const code = error instanceof Error ? error.message : "unknown";
	console.error(`server failed: ${code}`);
	process.exit(1);
});
