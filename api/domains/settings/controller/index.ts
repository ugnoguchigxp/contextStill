import type { Hono } from "hono";
import { parseJsonBody } from "../../../infrastructure/http";
import { putLarmBodySchema } from "../contracts";
import type { SettingsService } from "../service";

export interface SettingsControllerDeps {
	settings: SettingsService;
	/** Whether the LARM control token is present in the environment (never its value). */
	larmTokenPresent: () => boolean;
}

export function registerSettings(app: Hono, deps: SettingsControllerDeps) {
	app.get("/api/settings", (c) =>
		c.json({
			settings: deps.settings.get(),
			diagnostics: deps.settings.diagnostics(),
			secrets: { larmToken: { present: deps.larmTokenPresent() } },
		}),
	);
	app.put("/api/settings/larm", async (c) => {
		const body = await parseJsonBody(c, putLarmBodySchema);
		if (!body.ok) return body.response;
		return c.json(await deps.settings.setLarm({ baseUrl: body.data.baseUrl }));
	});
}
