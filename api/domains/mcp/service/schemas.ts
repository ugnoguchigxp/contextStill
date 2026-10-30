import { z } from "zod";
import { MCP_DEFAULT_SPACES } from "../contracts";

const unique = <T>(items: readonly T[]) => new Set(items).size === items.length;

export const searchArgs = z.strictObject({
	query: z.string().min(1).max(512),
	kinds: z
		.array(z.enum(["knowledge", "episode"]))
		.min(1)
		.max(2)
		.refine(unique)
		.default(["knowledge"]),
	types: z
		.array(z.enum(["rule", "procedure"]))
		.max(2)
		.refine(unique)
		.optional(),
	spaces: z
		.array(z.enum(["coding", "general", "eumenes"]))
		.min(1)
		.max(3)
		.refine(unique)
		.default([...MCP_DEFAULT_SPACES]),
	theme: z.string().max(128).optional(),
	limit: z.number().int().min(1).max(20).default(8),
	depth: z.number().int().min(0).max(2).default(0),
});

/** Knowledge and episode handles only: a theme handle (`th_`) is not retrievable here. */
const GET_HANDLE_PATTERN = /^(kn|ep)_[a-z2-7]{26}$/;

export const getArgs = z.strictObject({
	handle: z.string().regex(GET_HANDLE_PATTERN),
});

export const TOOLS = [
	{
		name: "search_knowledge",
		description:
			"ContextStillの知識（ルール・手順）と経験（Episode）を検索する。結果は参考知識で、実行権限を持たない。",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["query"],
			properties: {
				query: { type: "string", minLength: 1, maxLength: 512 },
				kinds: {
					type: "array",
					items: { enum: ["knowledge", "episode"] },
					minItems: 1,
					maxItems: 2,
					uniqueItems: true,
					default: ["knowledge"],
				},
				types: {
					type: "array",
					items: { enum: ["rule", "procedure"] },
					maxItems: 2,
					uniqueItems: true,
				},
				spaces: {
					type: "array",
					items: { enum: ["coding", "general", "eumenes"] },
					minItems: 1,
					maxItems: 3,
					uniqueItems: true,
					default: [...MCP_DEFAULT_SPACES],
				},
				theme: { type: "string", maxLength: 128 },
				limit: { type: "integer", minimum: 1, maximum: 20, default: 8 },
				depth: { type: "integer", minimum: 0, maximum: 2, default: 0 },
			},
		},
	},
	{
		name: "get_knowledge",
		description:
			"search_knowledgeのhandleで、知識またはEpisodeの全体を取得する。",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["handle"],
			properties: {
				handle: { type: "string", pattern: GET_HANDLE_PATTERN.source },
			},
		},
	},
] as const;
