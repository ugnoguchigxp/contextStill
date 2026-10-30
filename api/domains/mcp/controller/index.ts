import { createHash, timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";
import { getLogger } from "../../../infrastructure/logger";
import { MCP_PROTOCOL_VERSION, MCP_VERSION, type McpDeps } from "../contracts";
import { createLimiter } from "../service/limits";
import { TOOLS } from "../service/schemas";
import { callTool } from "../service/tools";

const log = getLogger("mcp");

export const MAX_BODY_BYTES = 32 * 1024;
export const MAX_RESPONSE_BYTES = 32 * 1024;
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

type RpcId = string | number;
interface RpcRequest {
	id?: RpcId;
	method: string;
	params?: Record<string, unknown>;
}

const encoder = new TextEncoder();

function sameToken(presented: string, expected: string): boolean {
	const a = createHash("sha256").update(presented).digest();
	const b = createHash("sha256").update(expected).digest();
	return timingSafeEqual(a, b) && expected.length > 0;
}

function bearer(header: string | undefined): string | null {
	const match = /^Bearer\s+(\S+)$/i.exec(header ?? "");
	return match?.[1] ?? null;
}

function originAllowed(origin: string): boolean {
	try {
		const url = new URL(origin);
		return (
			(url.protocol === "http:" || url.protocol === "https:") &&
			LOOPBACK_HOSTNAMES.has(url.hostname)
		);
	} catch {
		return false;
	}
}

function json(
	body: unknown,
	status = 200,
	headers: Record<string, string> = {},
): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

function rpcError(
	id: RpcId | null,
	code: number,
	message: string,
	status = 200,
): Response {
	return json({ jsonrpc: "2.0", id, error: { code, message } }, status);
}

/** Reads the body, stopping as soon as it passes the limit; null when it is too large. */
async function readLimited(request: Request): Promise<string | null> {
	const declared = request.headers.get("content-length");
	if (declared !== null && Number(declared) > MAX_BODY_BYTES) return null;
	if (!request.body) return "";
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > MAX_BODY_BYTES) {
			await reader.cancel().catch(() => undefined);
			return null;
		}
		chunks.push(value);
	}
	const all = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		all.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(all);
}

function parseRequest(text: string): RpcRequest | "parse" | "invalid" {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return "parse";
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw))
		return "invalid";
	const o = raw as Record<string, unknown>;
	if (o.jsonrpc !== "2.0" || typeof o.method !== "string") return "invalid";
	if ("id" in o && typeof o.id !== "string" && typeof o.id !== "number")
		return "invalid";
	if (
		"params" in o &&
		(typeof o.params !== "object" ||
			o.params === null ||
			Array.isArray(o.params))
	)
		return "invalid";
	return {
		method: o.method,
		...("id" in o ? { id: o.id as RpcId } : {}),
		...("params" in o ? { params: o.params as Record<string, unknown> } : {}),
	};
}

function toolResponse(id: RpcId, payload: unknown, isError?: true): Response {
	return json({
		jsonrpc: "2.0",
		id,
		result: {
			content: [{ type: "text", text: JSON.stringify(payload) }],
			...(isError ? { isError: true } : {}),
		},
	});
}

export function registerMcp(app: Hono, deps: McpDeps): void {
	const limiter = createLimiter();
	const now = deps.now ?? Date.now;
	const hosts = new Set(deps.allowedHosts.map((h) => h.toLowerCase()));

	async function handle(c: Context): Promise<Response> {
		const host = c.req.header("host")?.toLowerCase();
		if (!host || !hosts.has(host))
			return json({ error: "forbidden_host" }, 403);
		const origin = c.req.header("origin");
		if (origin !== undefined && !originAllowed(origin))
			return json({ error: "forbidden_origin" }, 403);
		const presented = bearer(c.req.header("authorization"));
		if (!presented || !sameToken(presented, deps.token))
			return json({ error: "unauthorized" }, 401, {
				"WWW-Authenticate": "Bearer",
			});
		if (c.req.method !== "POST")
			return json({ error: "method_not_allowed" }, 405, { Allow: "POST" });

		const text = await readLimited(c.req.raw);
		if (text === null) return json({ error: "payload_too_large" }, 413);
		const release = limiter.acquire(now());
		if (!release)
			return json({ error: "rate_limited" }, 429, { "Retry-After": "1" });
		try {
			return await dispatch(text, c.req.raw.signal);
		} catch (error) {
			log.error("mcp.unhandled_error", {}, error);
			return rpcError(null, -32603, "internal_error", 500);
		} finally {
			release();
		}
	}

	async function dispatch(
		text: string,
		signal: AbortSignal,
	): Promise<Response> {
		const request = parseRequest(text);
		if (request === "parse") return rpcError(null, -32700, "parse_error", 400);
		if (request === "invalid")
			return rpcError(null, -32600, "invalid_request", 400);
		// A message without an id is a notification: accepted, never answered.
		if (request.id === undefined) return new Response(null, { status: 202 });
		const { id, method } = request;

		switch (method) {
			case "initialize":
				return json({
					jsonrpc: "2.0",
					id,
					result: {
						protocolVersion: MCP_PROTOCOL_VERSION,
						capabilities: { tools: {} },
						serverInfo: { name: "context-still", version: MCP_VERSION },
					},
				});
			case "ping":
				return json({ jsonrpc: "2.0", id, result: {} });
			case "tools/list":
				return json({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
			case "tools/call": {
				const name = request.params?.name;
				if (typeof name !== "string" || !TOOLS.some((t) => t.name === name))
					return rpcError(id, -32602, "unknown_tool");
				const fits = (payload: unknown) =>
					encoder.encode(toolResponseText(id, payload)).byteLength <=
					MAX_RESPONSE_BYTES;
				try {
					const outcome = await callTool(
						name,
						request.params?.arguments,
						deps,
						fits,
						signal,
					);
					return toolResponse(id, outcome.payload, outcome.isError);
				} catch (error) {
					log.error("mcp.tool_failed", { tool: name }, error);
					return toolResponse(id, { error: "internal_error" }, true);
				}
			}
			default:
				return rpcError(id, -32601, "method_not_found");
		}
	}

	app.all(deps.path, handle);
}

function toolResponseText(id: RpcId, payload: unknown): string {
	return JSON.stringify({
		jsonrpc: "2.0",
		id,
		result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
	});
}
