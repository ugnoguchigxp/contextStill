import type {
	ChatRequest,
	ChatResult,
	LarmChatDeps,
	LlmClient,
} from "../contracts";
import {
	createLarmConnection,
	isObject,
	retryAfter,
	type Json,
} from "./connection";

const OPENAI_PROTOCOL = "openai.chat-completions.v1";
const OPENAI_CONFIGURATION = "openai-provider-v1";
const DEFAULT_BUSY_RETRY_MS = 30_000;
const DEFAULT_CHAT_TIMEOUT_MS = 300_000;
const MAX_CHAT_BYTES = 1024 * 1024;
const MAX_FIELD_LENGTH = 256;
const MAX_TOKEN_LENGTH = 8192;
const MAX_OUTPUT_TOKENS = 16384;
/** The port LARM's old static provider used; a claim must not point there. */
const LEGACY_STATIC_PORT = 44448;

interface ChatTarget {
	baseUrl: string;
	model: string;
}

const nonEmpty = (value: unknown, max = MAX_FIELD_LENGTH): value is string =>
	typeof value === "string" && value.length > 0 && value.length <= max;

const normalizeHost = (host: string) =>
	host.replace(/^\[|\]$/g, "").toLowerCase();

/** The port of a URL; one left out is the default of its scheme. */
const portOf = (url: URL) =>
	url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);

/**
 * The claimed base URL: `/v1` on the same host as the control URL, with the same scheme (an https
 * control never sends the credential over http), on a port that is not forbidden.
 */
function claimedBase(
	value: unknown,
	control: URL,
	forbiddenPorts: readonly number[],
): URL | null {
	if (!nonEmpty(value, 2048)) return null;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return null;
	}
	if (
		(url.protocol !== "http:" && url.protocol !== "https:") ||
		url.username !== "" ||
		url.password !== "" ||
		url.search !== "" ||
		url.hash !== "" ||
		url.pathname !== "/v1" ||
		normalizeHost(url.hostname) !== normalizeHost(control.hostname) ||
		(control.protocol === "https:" && url.protocol !== "https:") ||
		portOf(url) === LEGACY_STATIC_PORT ||
		forbiddenPorts.includes(portOf(url))
	)
		return null;
	return url;
}

export function createLarmChat(deps: LarmChatDeps): LlmClient {
	const chatTimeoutMs = deps.chatTimeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS;
	/** Set once a provider has answered a json request that left `response_format` out. */
	let jsonUnsupported = false;

	const link = createLarmConnection<ChatTarget>(deps, {
		profile: deps.llmProfile,
		createExtra: { providers: ["llm"] },
		mismatchCode: "larm_contract_mismatch",
		provider(body, ctx) {
			const providers = body.providers;
			const first = Array.isArray(providers) ? providers[0] : undefined;
			if (
				body.profile !== ctx.profile ||
				!nonEmpty(body.agentProfile) ||
				(body.audience !== undefined && body.audience !== ctx.audience) ||
				!Array.isArray(providers) ||
				providers.length !== 1 ||
				!isObject(first) ||
				first.name !== "llm" ||
				first.protocol !== OPENAI_PROTOCOL ||
				first.endpoint !== "/v1/chat/completions" ||
				!nonEmpty(first.model)
			)
				return "larm_contract_mismatch";
			return { first, pin: first.model };
		},
		claimFormat: OPENAI_CONFIGURATION,
		parseClaim(body, { base, connectionId, pin }) {
			const providers = body.providers;
			const first = Array.isArray(providers) ? providers[0] : undefined;
			if (
				body.id !== connectionId ||
				(body.status !== undefined && body.status !== "ready") ||
				!Array.isArray(providers) ||
				providers.length !== 1 ||
				!isObject(first) ||
				first.name !== "llm" ||
				first.protocol !== OPENAI_PROTOCOL ||
				first.model !== pin
			)
				return "larm_contract_mismatch";
			const configuration = first.configuration;
			const credential = first.credential;
			const url = claimedBase(first.baseUrl, base, deps.forbiddenPorts ?? []);
			if (
				!url ||
				!isObject(configuration) ||
				configuration.kind !== OPENAI_CONFIGURATION ||
				!isObject(configuration.fields) ||
				configuration.fields.baseURL !== first.baseUrl ||
				configuration.fields.model !== pin ||
				!isObject(configuration.secretFields) ||
				configuration.secretFields.apiKey !== "credential.token" ||
				!isObject(credential) ||
				credential.type !== "bearer" ||
				!nonEmpty(credential.token, MAX_TOKEN_LENGTH) ||
				typeof credential.expiresAt !== "string"
			)
				return "larm_contract_mismatch";
			const expiresAtMs = Date.parse(credential.expiresAt);
			if (Number.isNaN(expiresAtMs)) return "larm_contract_mismatch";
			return {
				target: { baseUrl: url.toString().replace(/\/$/, ""), model: pin },
				token: credential.token,
				expiresAtMs,
			};
		},
	});
	const { fail } = link;

	function validateRequest(req: ChatRequest): void {
		if (
			!Number.isInteger(req.maxOutputTokens) ||
			req.maxOutputTokens < 1 ||
			req.maxOutputTokens > MAX_OUTPUT_TOKENS ||
			req.messages.length === 0
		)
			throw new RangeError("chat_request_invalid");
	}

	function parseResult(body: Json, model: string): ChatResult {
		const choices = body.choices;
		const choice = Array.isArray(choices) ? choices[0] : undefined;
		const message = isObject(choice) ? choice.message : undefined;
		if (!isObject(message) || typeof message.content !== "string")
			return fail("larm_contract_mismatch");
		const reason = isObject(choice) ? choice.finish_reason : undefined;
		const usage = isObject(body.usage) ? body.usage : {};
		const count = (value: unknown) =>
			typeof value === "number" && Number.isInteger(value) && value >= 0
				? value
				: null;
		return {
			text: message.content,
			model,
			finishReason:
				reason === "stop" ? "stop" : reason === "length" ? "length" : "other",
			usage: {
				inputTokens: count(usage.prompt_tokens),
				outputTokens: count(usage.completion_tokens),
			},
		};
	}

	async function send(
		req: ChatRequest,
		target: { target: ChatTarget; token: string },
		withJson: boolean,
	): Promise<Response> {
		return link.request(
			`${target.target.baseUrl}/chat/completions`,
			{
				method: "POST",
				token: target.token,
				body: {
					model: target.target.model,
					messages: req.messages,
					max_tokens: req.maxOutputTokens,
					stream: false,
					...(withJson ? { response_format: { type: "json_object" } } : {}),
				},
			},
			chatTimeoutMs,
			req.signal,
		);
	}

	return {
		provider: "larm",
		model: () => link.currentTarget()?.model ?? null,
		status: () => link.status(),
		async chat(req) {
			validateRequest(req);
			for (let attempt = 0; ; attempt++) {
				const target = await link.acquire(req.signal, attempt > 0);
				const wantJson = req.json && !jsonUnsupported;
				let response = await send(req, target, wantJson);
				// A provider that does not know `response_format` is asked again without it.
				if (wantJson && (response.status === 400 || response.status === 422)) {
					await response.body?.cancel().catch(() => {});
					response = await send(req, target, false);
					if (response.status === 200) jsonUnsupported = true;
				}
				if (response.status === 503)
					return link.reject(
						response,
						"larm_busy",
						retryAfter(response, DEFAULT_BUSY_RETRY_MS),
					);
				if (response.status === 401 || response.status === 403) {
					// The credential was refused: drop it and claim again, once.
					link.dropCredential();
					await response.body?.cancel().catch(() => {});
					if (attempt === 0) continue;
					return fail("larm_http_error");
				}
				if (response.status !== 200)
					return link.reject(response, "larm_http_error");
				const result = parseResult(
					await link.readJson(response, MAX_CHAT_BYTES, "larm_http_error"),
					target.target.model,
				);
				link.markHealthy();
				return result;
			}
		},
		release: () => link.release(),
	};
}
