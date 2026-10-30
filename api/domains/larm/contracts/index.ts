/**
 * The larm-embedding.v1 contract: ContextStill embeds with exactly this model through LARM,
 * and every stored vector belongs to the space below (`vectorSpaceKey` of its shape).
 */
export const LARM_EMBEDDING_SPACE = {
	contractVersion: "larm-embedding.v1",
	workload: "embedding",
	model: {
		id: "intfloat/multilingual-e5-small",
		revision: "614241f622f53c4eeff9890bdc4f31cfecc418b3",
		artifactDigest:
			"63bc913284590439c0fdadcd5f61ee9ad9630591075314bc975fb190983ed62c",
	},
	dimension: 384,
	inputTypes: ["query", "passage"],
	prefixes: { query: "query: ", passage: "passage: " },
	normalization: "l2",
	tokenization: {
		kind: "sentencepiece-bpe",
		tokenizerDigest:
			"0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39",
		maxTokens: 512,
		truncation: "end",
		pooling: "mean",
	},
} as const;
export type LarmEmbeddingSpace = typeof LARM_EMBEDDING_SPACE;

export type EmbeddingInputType = "query" | "passage";

export type LarmErrorCode =
	| "larm_not_configured"
	| "larm_token_missing"
	| "larm_unreachable"
	| "larm_busy"
	| "larm_provider_conflict"
	| "larm_deploying"
	| "larm_contract_mismatch"
	| "larm_embedding_space_mismatch"
	| "larm_http_error";

/** The message is the code: no token, URL or provider text ever enters an error. */
export class LarmError extends Error {
	constructor(
		public code: LarmErrorCode,
		public retryAfterMs?: number,
	) {
		super(code);
		this.name = "LarmError";
	}
}

export interface LarmEmbeddingStatus {
	configured: boolean;
	tokenPresent: boolean;
	connection: "none" | "ready" | "error";
	lastError: LarmErrorCode | null;
}

export interface LarmEmbeddingClient {
	status(): LarmEmbeddingStatus;
	/** `texts` are plain text. The client adds no `query: ` / `passage: ` prefix (unverified, see the plan 5.4). */
	embed(
		texts: string[],
		type: EmbeddingInputType,
		opts?: { signal?: AbortSignal },
	): Promise<Float32Array[]>;
	release(): Promise<void>;
}

export interface LarmEmbeddingDeps {
	baseUrl: () => string | null;
	token: () => string | undefined;
	audience: () => "same-host" | "saaa-desktop" | null;
	profile: () => string;
	fetch: typeof fetch;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	controlTimeoutMs?: number;
	embedTimeoutMs?: number;
	maxBatch?: number;
}

export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

export interface ChatRequest {
	messages: ChatMessage[];
	/** 1..16384 */
	maxOutputTokens: number;
	/** true: send `response_format {"type":"json_object"}` (left out when the provider does not support it). */
	json: boolean;
	signal?: AbortSignal;
}

export interface ChatResult {
	text: string;
	model: string;
	finishReason: "stop" | "length" | "other";
	usage: { inputTokens: number | null; outputTokens: number | null };
}

/** The chat side of LARM (provider `llm`). A failure is a `LarmError`. */
export interface LlmClient {
	readonly provider: "larm" | "fixture";
	/**
	 * The model of the connection when it is already known, else null. Part of the key under which
	 * `callJson` reuses an earlier answer.
	 */
	model?(): string | null;
	/** Same shape as the embedding client's status. */
	status(): LarmEmbeddingStatus;
	chat(req: ChatRequest): Promise<ChatResult>;
	release(): Promise<void>;
}

/** `chatTimeoutMs` defaults to 300000; a response body is cut at 1 MiB (`larm_http_error`). */
export type LarmChatDeps = LarmEmbeddingDeps & {
	llmProfile: () => string;
	chatTimeoutMs?: number;
	/**
	 * Ports a claimed provider baseURL may not use, besides LARM's own: the legacy daemon's and
	 * this backend's. The credential and the knowledge text must never be sent to them.
	 */
	forbiddenPorts?: readonly number[];
};

export const errorStatus = {
	larm_not_configured: 503,
	larm_token_missing: 503,
	larm_unreachable: 502,
	larm_busy: 503,
	larm_provider_conflict: 409,
	larm_deploying: 503,
	larm_contract_mismatch: 502,
	larm_embedding_space_mismatch: 502,
	larm_http_error: 502,
} as const;
