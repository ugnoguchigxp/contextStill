import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { getLogger } from "../infrastructure/logger";
import { registerLarm } from "../domains/larm";
import { registerMcp } from "../domains/mcp";
import { registerSettings } from "../domains/settings";
import { APP_VERSION } from "./config";
import { errorResponse } from "./error-status";
import type { Runtime } from "./runtime";

const log = getLogger("app");

/** Comparison time does not depend on where the tokens first differ. */
function sameToken(presented: string, expected: string): boolean {
	const a = createHash("sha256").update(presented).digest();
	const b = createHash("sha256").update(expected).digest();
	return timingSafeEqual(a, b);
}

function bearer(header: string | undefined): string | null {
	const match = /^Bearer\s+(\S+)$/i.exec(header ?? "");
	return match?.[1] ?? null;
}

/** `/api/health` is open; the rest of `/api/*` needs the API token. `/mcp` has its own token. */
export function createApp(
	runtime: Runtime,
	tokens: { api: string; mcp: string },
): Hono {
	const app = new Hono();
	const { port } = runtime.config;
	const allowedHosts = [
		`127.0.0.1:${port}`,
		`localhost:${port}`,
		`[::1]:${port}`,
	];

	app.get("/api/health", (c) => c.json({ ok: true, version: APP_VERSION }));

	app.use("/api/*", async (c, next) => {
		if (c.req.path === "/api/health") return next();
		const presented = bearer(c.req.header("authorization"));
		if (!presented || !sameToken(presented, tokens.api))
			return c.json({ error: "unauthorized" }, 401, {
				"WWW-Authenticate": "Bearer",
			});
		return next();
	});

	registerSettings(app, {
		settings: runtime.settings,
		larmTokenPresent: () => !!runtime.config.larmToken,
	});
	registerLarm(app, runtime.larm);
	registerMcp(app, {
		path: "/mcp",
		token: tokens.mcp,
		allowedHosts,
		search: runtime.search,
		store: runtime.store,
		now: () => runtime.now().getTime(),
	});

	app.onError((error, c) => {
		const { error: code, status } = errorResponse(error);
		if (status === 500)
			log.error("app.unhandled_error", { path: c.req.path }, error);
		return c.json({ error: code }, status);
	});
	app.notFound((c) => c.json({ error: "not_found" }, 404));
	return app;
}
