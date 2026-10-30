import type { Hono } from "hono";
import type { LarmEmbeddingClient } from "../contracts";

export function registerLarm(app: Hono, client: LarmEmbeddingClient) {
	app.get("/api/larm/status", (c) => c.json(client.status()));
}
