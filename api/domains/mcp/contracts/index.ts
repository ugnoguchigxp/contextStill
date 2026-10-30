import type { Hono } from "hono";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { SearchService } from "../../search";

export interface McpDeps {
	path: "/mcp";
	token: string;
	/** 例 ["127.0.0.1:39181","localhost:39181","[::1]:39181"] */
	allowedHosts: string[];
	search: SearchService;
	store: SqliteStore;
	now?: () => number;
}

export type RegisterMcp = (app: Hono, deps: McpDeps) => void;

export const MCP_VERSION = "2.0.0-alpha.0";
export const MCP_PROTOCOL_VERSION = "2025-03-26";
