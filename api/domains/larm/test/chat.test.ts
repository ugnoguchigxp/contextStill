import { expect, test } from "bun:test";
import { createLarmChat } from "../service";
import {
	LarmError,
	type ChatRequest,
	type LarmChatDeps,
	type LarmErrorCode,
} from "../index";

const BASE = "http://127.0.0.1:4500";
const CONTROL_TOKEN = "control-secret-456";
const CREDENTIAL = "credential-secret-123";
const CONNECTION_ID = "conn_llm.01";
const MODEL = "qwen3-fixture";
const PROFILE = "contextStill";
const SECRET_TEXT = "model-said-secret-words";

interface Call {
	method: string;
	url: string;
	headers: Record<string, string>;
	body: any;
}

const providerBody = (readiness = "ready") => ({
	id: CONNECTION_ID,
	status: readiness === "ready" ? "ready" : "pending",
	claimable: readiness === "ready",
	profile: PROFILE,
	agentProfile: "contextStill-v3",
	audience: "same-host",
	providers: [
		{
			name: "llm",
			capability: "llm",
			protocol: "openai.chat-completions.v1",
			endpoint: "/v1/chat/completions",
			model: MODEL,
			readiness,
			claimable: readiness === "ready",
		},
	],
});

function fixture() {
	const calls: Call[] = [];
	const clock = { now: Date.parse("2026-10-30T00:00:00.000Z") };
	const sleeps: number[] = [];
	let chats = 0;
	const state = {
		createStatus: 201,
		createRetryAfter: null as string | null,
		createBody: () => providerBody() as any,
		pollBodies: [] as (() => any)[],
		claimStatus: 200,
		claimBody: (): any => ({}),
		chatStatus: (_n: number, _body: any) => 200,
		chatRetryAfter: null as string | null,
		chatBody: (_n: number): any => ({
			model: MODEL,
			choices: [
				{
					message: { role: "assistant", content: "hello" },
					finish_reason: "stop",
				},
			],
			usage: { prompt_tokens: 12, completion_tokens: 3 },
		}),
		chatRaw: null as null | (() => Response),
		deleteStatus: 204,
		failNetwork: false,
		credentialLifetimeMs: 10 * 60_000,
	};
	state.claimBody = () => ({
		id: CONNECTION_ID,
		status: "ready",
		audience: "same-host",
		providers: [
			{
				name: "llm",
				capability: "llm",
				apiStyle: "openai",
				protocol: "openai.chat-completions.v1",
				baseUrl: `${BASE}/v1`,
				model: MODEL,
				configuration: {
					kind: "openai-provider-v1",
					fields: { baseURL: `${BASE}/v1`, model: MODEL },
					secretFields: { apiKey: "credential.token" },
				},
				credential: {
					type: "bearer",
					token: CREDENTIAL,
					expiresAt: new Date(
						clock.now + state.credentialLifetimeMs,
					).toISOString(),
				},
			},
		],
	});
	const json = (
		body: unknown,
		status = 200,
		headers: Record<string, string> = {},
	) =>
		new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json", ...headers },
		});
	const fake = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		const headers = Object.fromEntries(
			Object.entries((init?.headers ?? {}) as Record<string, string>).map(
				([k, v]) => [k.toLowerCase(), v],
			),
		);
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		calls.push({ method, url, headers, body });
		if (state.failNetwork)
			throw new Error(`connect ECONNREFUSED ${CONTROL_TOKEN} ${CREDENTIAL}`);
		const path = decodeURIComponent(new URL(url).pathname);
		if (method === "POST" && path === "/v1/agent-connections")
			return json(
				state.createBody(),
				state.createStatus,
				state.createRetryAfter ? { "retry-after": state.createRetryAfter } : {},
			);
		if (method === "GET" && path === `/v1/agent-connections/${CONNECTION_ID}`)
			return json((state.pollBodies.shift() ?? state.createBody)());
		if (
			method === "POST" &&
			path === `/v1/agent-connections/${CONNECTION_ID}/claim`
		)
			return json(state.claimBody(), state.claimStatus);
		if (
			method === "DELETE" &&
			path === `/v1/agent-connections/${CONNECTION_ID}`
		)
			return new Response(null, { status: state.deleteStatus });
		if (method === "POST" && path === "/v1/chat/completions") {
			chats++;
			if (state.chatRaw) return state.chatRaw();
			const status = state.chatStatus(chats, body);
			return json(
				status === 200 ? state.chatBody(chats) : { error: SECRET_TEXT },
				status,
				state.chatRetryAfter ? { "retry-after": state.chatRetryAfter } : {},
			);
		}
		return new Response("{}", { status: 404 });
	}) as unknown as typeof fetch;
	return {
		calls,
		sleeps,
		clock,
		state,
		fetch: fake,
		count: (method: string, part: string) =>
			calls.filter((c) => c.method === method && c.url.includes(part)).length,
		creates: () =>
			calls.filter(
				(c) =>
					c.method === "POST" &&
					new URL(c.url).pathname === "/v1/agent-connections",
			).length,
	};
}
type Fixture = ReturnType<typeof fixture>;

function client(fx: Fixture, over: Partial<LarmChatDeps> = {}) {
	return createLarmChat({
		baseUrl: () => BASE,
		token: () => CONTROL_TOKEN,
		audience: () => null,
		profile: () => "embeddingCanary",
		llmProfile: () => PROFILE,
		fetch: fx.fetch,
		now: () => fx.clock.now,
		sleep: async (ms) => {
			fx.sleeps.push(ms);
		},
		...over,
	});
}

const request = (over: Partial<ChatRequest> = {}): ChatRequest => ({
	messages: [
		{ role: "system", content: "sys" },
		{ role: "user", content: "hi" },
	],
	maxOutputTokens: 256,
	json: false,
	...over,
});

async function errorOf(promise: Promise<unknown>): Promise<LarmError> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(LarmError);
		return error as LarmError;
	}
	throw new Error("expected a LarmError");
}
const codeOf = async (promise: Promise<unknown>): Promise<LarmErrorCode> =>
	(await errorOf(promise)).code;

test("create, claim and chat in the order of the contract", async () => {
	const fx = fixture();
	const larm = client(fx);
	expect(larm.provider).toBe("larm");
	expect(larm.model!()).toBeNull();
	const result = await larm.chat(request());
	expect(result).toEqual({
		text: "hello",
		model: MODEL,
		finishReason: "stop",
		usage: { inputTokens: 12, outputTokens: 3 },
	});
	expect(fx.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(
		[
			"POST /v1/agent-connections",
			`POST /v1/agent-connections/${CONNECTION_ID}/claim`,
			"POST /v1/chat/completions",
		],
	);
	const [create, claim, chat] = fx.calls;
	expect(create!.headers.authorization).toBe(`Bearer ${CONTROL_TOKEN}`);
	expect(create!.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
	expect(create!.body).toEqual({
		profile: PROFILE,
		audience: "same-host",
		client: "contextstill",
		ttlSeconds: 300,
		allowFallback: false,
		deploymentPolicy: "existing-only",
		providers: ["llm"],
	});
	expect(claim!.body).toEqual({ format: "openai-provider-v1" });
	// The claimed credential, base URL and model drive the inference.
	expect(chat!.url).toBe(`${BASE}/v1/chat/completions`);
	expect(chat!.headers.authorization).toBe(`Bearer ${CREDENTIAL}`);
	expect(chat!.body).toEqual({
		model: MODEL,
		messages: request().messages,
		max_tokens: 256,
		stream: false,
	});
	expect(larm.model!()).toBe(MODEL);
	expect(larm.status()).toEqual({
		configured: true,
		tokenPresent: true,
		connection: "ready",
		lastError: null,
	});
});

test("a 202 create is polled until ready, one second apart", async () => {
	const fx = fixture();
	fx.state.createStatus = 202;
	fx.state.createBody = () => providerBody("pending");
	fx.state.pollBodies = [() => providerBody("pending"), () => providerBody()];
	await client(fx).chat(request());
	expect(fx.count("GET", `/v1/agent-connections/${CONNECTION_ID}`)).toBe(2);
	expect(fx.sleeps).toEqual([1000]);
	expect(fx.count("POST", "/claim")).toBe(1);
});

test("a connection that never becomes ready is larm_deploying", async () => {
	const fx = fixture();
	fx.state.createStatus = 202;
	fx.state.createBody = () => providerBody("pending");
	expect(await codeOf(client(fx).chat(request()))).toBe("larm_deploying");
	expect(fx.count("POST", "/v1/chat/completions")).toBe(0);
});

test("a response that is not the requested llm provider is refused and nothing is inferred", async () => {
	for (const tamper of [
		(b: any) => (b.profile = "other"),
		(b: any) => delete b.agentProfile,
		(b: any) => (b.audience = "saaa-desktop"),
		(b: any) => (b.providers[0].name = "embedding"),
		(b: any) => (b.providers[0].protocol = "openai.responses.v1"),
		(b: any) => (b.providers[0].endpoint = "/v1/other"),
		(b: any) => (b.providers[0].model = ""),
		(b: any) => (b.providers = []),
		(b: any) => b.providers.push(structuredClone(b.providers[0])),
		(b: any) => (b.id = "bad id!"),
	]) {
		const fx = fixture();
		fx.state.createBody = () => {
			const body = providerBody();
			tamper(body);
			return body;
		};
		const larm = client(fx);
		expect(await codeOf(larm.chat(request()))).toBe("larm_contract_mismatch");
		expect(fx.count("POST", "/v1/chat/completions")).toBe(0);
		expect(fx.count("POST", "/claim")).toBe(0);
		expect(larm.status().connection).toBe("error");
	}
});

test("a claim that does not match the created connection is refused", async () => {
	for (const tamper of [
		(b: any) => (b.id = "conn_other"),
		(b: any) => (b.status = "pending"),
		(b: any) => (b.providers[0].model = "other-model"),
		(b: any) => (b.providers[0].protocol = "openai.responses.v1"),
		(b: any) => (b.providers[0].name = "embedding"),
		(b: any) => (b.providers[0].baseUrl = `${BASE}/v2`),
		(b: any) => (b.providers[0].baseUrl = `http://evil.example.test/v1`),
		(b: any) => (b.providers[0].baseUrl = `http://user:pw@127.0.0.1:4500/v1`),
		(b: any) => (b.providers[0].baseUrl = `http://127.0.0.1:44448/v1`),
		(b: any) => (b.providers[0].configuration.kind = "other"),
		(b: any) => (b.providers[0].configuration.fields.model = "other-model"),
		(b: any) => (b.providers[0].configuration.fields.baseURL = `${BASE}/v1/`),
		(b: any) => (b.providers[0].configuration.secretFields.apiKey = "other"),
		(b: any) => (b.providers[0].credential.type = "basic"),
		(b: any) => (b.providers[0].credential.token = ""),
		(b: any) => (b.providers[0].credential.expiresAt = "not a date"),
		(b: any) => (b.providers = []),
	]) {
		const fx = fixture();
		const original = fx.state.claimBody;
		fx.state.claimBody = () => {
			const body = original();
			tamper(body);
			return body;
		};
		expect(await codeOf(client(fx).chat(request()))).toBe(
			"larm_contract_mismatch",
		);
		expect(fx.count("POST", "/v1/chat/completions")).toBe(0);
	}
});

test("a model that changes between create and poll is refused", async () => {
	const fx = fixture();
	fx.state.createStatus = 202;
	fx.state.createBody = () => providerBody("pending");
	fx.state.pollBodies = [
		() => {
			const body = providerBody();
			body.providers[0]!.model = "swapped-model";
			return body;
		},
	];
	expect(await codeOf(client(fx).chat(request()))).toBe(
		"larm_contract_mismatch",
	);
	expect(fx.count("POST", "/claim")).toBe(0);
});

test("503 on chat is larm_busy: Retry-After, else 30 seconds", async () => {
	const fx = fixture();
	fx.state.chatStatus = () => 503;
	fx.state.chatRetryAfter = "7";
	const larm = client(fx);
	const first = await errorOf(larm.chat(request()));
	expect([first.code, first.retryAfterMs]).toEqual(["larm_busy", 7000]);
	fx.state.chatRetryAfter = null;
	const second = await errorOf(larm.chat(request()));
	expect([second.code, second.retryAfterMs]).toEqual(["larm_busy", 30_000]);
	// The connection is kept: busy is not a reason to connect again.
	expect(fx.creates()).toBe(1);
	expect(fx.count("POST", "/claim")).toBe(1);
});

test("409 on create is a provider conflict with Retry-After in milliseconds", async () => {
	const fx = fixture();
	fx.state.createStatus = 409;
	fx.state.createRetryAfter = "12";
	const error = await errorOf(client(fx).chat(request()));
	expect([error.code, error.retryAfterMs]).toEqual([
		"larm_provider_conflict",
		12_000,
	]);
});

test("other control failures are larm_http_error; unreachable is larm_unreachable", async () => {
	for (const status of [400, 404, 500, 503]) {
		const fx = fixture();
		fx.state.createStatus = status;
		expect(await codeOf(client(fx).chat(request()))).toBe("larm_http_error");
	}
	const fx = fixture();
	fx.state.claimStatus = 500;
	expect(await codeOf(client(fx).chat(request()))).toBe("larm_http_error");
	const down = fixture();
	down.state.failNetwork = true;
	expect(await codeOf(client(down).chat(request()))).toBe("larm_unreachable");
});

test("the credential is reused until 30 seconds before it expires, then claimed again", async () => {
	const fx = fixture();
	fx.state.credentialLifetimeMs = 120_000;
	const larm = client(fx);
	await larm.chat(request());
	await larm.chat(request());
	expect(fx.count("POST", "/claim")).toBe(1);
	fx.clock.now += 91_000;
	await larm.chat(request());
	expect(fx.count("POST", "/claim")).toBe(2);
	// The same connection is claimed again, not created again.
	expect(fx.creates()).toBe(1);
});

test("a refused credential (401/403) is replaced once, then it is an error", async () => {
	const fx = fixture();
	fx.state.chatStatus = (n) => (n === 1 ? 401 : 200);
	const larm = client(fx);
	expect((await larm.chat(request())).text).toBe("hello");
	expect(fx.count("POST", "/claim")).toBe(2);

	const always = fixture();
	always.state.chatStatus = () => 403;
	expect(await codeOf(client(always).chat(request()))).toBe("larm_http_error");
	expect(always.count("POST", "/v1/chat/completions")).toBe(2);
});

test("release deletes the connection and the next chat builds a new one", async () => {
	const fx = fixture();
	const larm = client(fx);
	await larm.chat(request());
	await larm.release();
	expect(fx.count("DELETE", `/v1/agent-connections/${CONNECTION_ID}`)).toBe(1);
	expect(larm.model!()).toBeNull();
	await larm.chat(request());
	expect(fx.creates()).toBe(2);
});

test("json:true sends response_format; a provider that rejects it is asked again without it", async () => {
	const fx = fixture();
	const larm = client(fx);
	await larm.chat(request({ json: true }));
	const chats = () =>
		fx.calls.filter((c) => c.url.endsWith("/chat/completions"));
	expect(chats()[0]!.body.response_format).toEqual({ type: "json_object" });
	await larm.chat(request({ json: false }));
	expect(chats()[1]!.body.response_format).toBeUndefined();

	const picky = fixture();
	picky.state.chatStatus = (_n, body) => (body.response_format ? 400 : 200);
	const second = client(picky);
	expect((await second.chat(request({ json: true }))).text).toBe("hello");
	expect(
		picky.calls
			.filter((c) => c.url.endsWith("/chat/completions"))
			.map((c) => !!c.body.response_format),
	).toEqual([true, false]);
	// Once known, it is not tried again.
	await second.chat(request({ json: true }));
	expect(
		picky.calls
			.filter((c) => c.url.endsWith("/chat/completions"))
			.map((c) => !!c.body.response_format),
	).toEqual([true, false, false]);
	// A 400 that is not about response_format stays an error.
	const bad = fixture();
	bad.state.chatStatus = () => 400;
	expect(await codeOf(client(bad).chat(request({ json: true })))).toBe(
		"larm_http_error",
	);
});

test("finish_reason and usage are mapped", async () => {
	const cases: [unknown, string][] = [
		["stop", "stop"],
		["length", "length"],
		["content_filter", "other"],
		[null, "other"],
	];
	for (const [reason, expected] of cases) {
		const fx = fixture();
		fx.state.chatBody = () => ({
			choices: [{ message: { content: "cut" }, finish_reason: reason }],
		});
		const result = await client(fx).chat(request());
		expect(result.finishReason).toBe(expected as any);
		expect(result.text).toBe("cut");
		expect(result.usage).toEqual({ inputTokens: null, outputTokens: null });
	}
});

test("a response that breaks the contract is larm_contract_mismatch", async () => {
	for (const body of [
		{},
		{ choices: [] },
		{ choices: [{ message: { content: null }, finish_reason: "stop" }] },
		{ choices: [{ message: {}, finish_reason: "stop" }] },
		{ choices: "x" },
	]) {
		const fx = fixture();
		fx.state.chatBody = () => body;
		expect(await codeOf(client(fx).chat(request()))).toBe(
			"larm_contract_mismatch",
		);
	}
	const text = fixture();
	text.state.chatRaw = () => new Response("not json", { status: 200 });
	expect(await codeOf(client(text).chat(request()))).toBe(
		"larm_contract_mismatch",
	);
});

test("a response larger than 1 MiB is larm_http_error, cut while streaming", async () => {
	const fx = fixture();
	let pulled = 0;
	fx.state.chatRaw = () =>
		new Response(
			new ReadableStream({
				pull(controller) {
					pulled++;
					controller.enqueue(new Uint8Array(256 * 1024).fill(97));
					if (pulled > 400) controller.close();
				},
			}),
			{ status: 200 },
		);
	expect(await codeOf(client(fx).chat(request()))).toBe("larm_http_error");
	expect(pulled).toBeLessThan(10);

	const declared = fixture();
	declared.state.chatRaw = () =>
		new Response("{}", {
			status: 200,
			headers: { "content-length": String(2 * 1024 * 1024) },
		});
	expect(await codeOf(client(declared).chat(request()))).toBe(
		"larm_http_error",
	);

	// Just under the limit is fine.
	const ok = fixture();
	ok.state.chatBody = () => ({
		choices: [
			{
				message: { content: "x".repeat(1024 * 1024 - 200) },
				finish_reason: "stop",
			},
		],
	});
	expect((await client(ok).chat(request())).text).toHaveLength(
		1024 * 1024 - 200,
	);
});

test("no error, status or message carries a token, URL or response text", async () => {
	const cases: ((fx: Fixture) => void)[] = [
		(fx) => (fx.state.failNetwork = true),
		(fx) => (fx.state.createStatus = 500),
		(fx) => (fx.state.claimStatus = 500),
		(fx) => (fx.state.chatStatus = () => 500),
		(fx) => (fx.state.chatStatus = () => 503),
		(fx) => (fx.state.chatBody = () => ({ choices: [], leak: SECRET_TEXT })),
		(fx) =>
			(fx.state.chatRaw = () => new Response(SECRET_TEXT, { status: 200 })),
	];
	for (const arrange of cases) {
		const fx = fixture();
		arrange(fx);
		const larm = client(fx);
		const error = await errorOf(larm.chat(request()));
		const dump = JSON.stringify([
			error.message,
			error.name,
			error.code,
			larm.status(),
		]);
		for (const secret of [
			CONTROL_TOKEN,
			CREDENTIAL,
			SECRET_TEXT,
			BASE,
			"127.0.0.1",
		])
			expect(dump).not.toContain(secret);
		expect(error.message).toBe(error.code);
	}
});

test("the request is validated before anything is sent", async () => {
	const fx = fixture();
	const larm = client(fx);
	for (const bad of [
		request({ maxOutputTokens: 0 }),
		request({ maxOutputTokens: 16385 }),
		request({ maxOutputTokens: 1.5 }),
		request({ messages: [] }),
	])
		await expect(larm.chat(bad)).rejects.toThrow("chat_request_invalid");
	await larm.chat(request({ maxOutputTokens: 16384 }));
	expect(fx.calls.length).toBe(3);
});

test("no token and no base URL are told apart and send nothing", async () => {
	const fx = fixture();
	expect(
		await codeOf(client(fx, { token: () => undefined }).chat(request())),
	).toBe("larm_token_missing");
	expect(
		await codeOf(client(fx, { baseUrl: () => null }).chat(request())),
	).toBe("larm_not_configured");
	expect(fx.calls).toHaveLength(0);
});

test("a changed llm profile makes a new connection", async () => {
	const fx = fixture();
	let profile = PROFILE;
	const larm = client(fx, { llmProfile: () => profile });
	await larm.chat(request());
	profile = "other";
	fx.state.createBody = () => ({ ...providerBody(), profile: "other" });
	await larm.chat(request());
	expect(fx.creates()).toBe(2);
	expect(
		fx.calls
			.filter((c) => c.url.endsWith("/v1/agent-connections"))
			.map((c) => c.body.profile),
	).toEqual([PROFILE, "other"]);
});

test("the timeout (chatTimeoutMs) ends a stuck call as larm_unreachable; the caller's abort surfaces as it is", async () => {
	const fx = fixture();
	const stuck = (async (input: string | URL | Request, init?: RequestInit) => {
		if (String(input).endsWith("/chat/completions"))
			return new Promise<Response>((_, reject) =>
				init?.signal?.addEventListener("abort", () =>
					reject(new Error(`aborted ${CREDENTIAL}`)),
				),
			);
		return fx.fetch(input, init);
	}) as unknown as typeof fetch;
	const larm = client(fx, { fetch: stuck, chatTimeoutMs: 30 });
	expect(await codeOf(larm.chat(request()))).toBe("larm_unreachable");

	const controller = new AbortController();
	const pending = larm.chat(request({ signal: controller.signal }));
	controller.abort(new Error("stop"));
	await expect(pending).rejects.toThrow("stop");
});

test("concurrent chats share one connection and one claim", async () => {
	const fx = fixture();
	const larm = client(fx);
	await Promise.all([
		larm.chat(request()),
		larm.chat(request()),
		larm.chat(request()),
	]);
	expect(fx.creates()).toBe(1);
	expect(fx.count("POST", "/claim")).toBe(1);
	expect(fx.count("POST", "/v1/chat/completions")).toBe(3);
});

/** A claim body whose baseUrl (and its copy in the configuration) is `baseUrl`. */
function claimingBase(fx: Fixture, baseUrl: string) {
	const original = fx.state.claimBody;
	fx.state.claimBody = () => {
		const body = original();
		body.providers[0].baseUrl = baseUrl;
		body.providers[0].configuration.fields.baseURL = baseUrl;
		return body;
	};
}

test("a claimed baseURL may not use a forbidden port, even on the control host", async () => {
	const forbiddenPorts = [39171, 39172, 39181];
	for (const baseUrl of [
		"http://127.0.0.1:39171/v1",
		"http://127.0.0.1:39172/v1",
		"http://127.0.0.1:39181/v1",
		"http://127.0.0.1:44448/v1",
	]) {
		const fx = fixture();
		claimingBase(fx, baseUrl);
		expect(await codeOf(client(fx, { forbiddenPorts }).chat(request()))).toBe(
			"larm_contract_mismatch",
		);
		expect(fx.count("POST", "/v1/chat/completions")).toBe(0);
	}
	// Another port on the same host is still accepted.
	const ok = fixture();
	claimingBase(ok, "http://127.0.0.1:4501/v1");
	const result = await client(ok, { forbiddenPorts }).chat(request());
	expect(result.text).toBe("hello");
	expect(ok.calls.at(-1)!.url).toBe(
		"http://127.0.0.1:4501/v1/chat/completions",
	);
});

test("a claimed baseURL without a port is judged as the default port of its scheme", async () => {
	const http = fixture();
	claimingBase(http, "http://127.0.0.1/v1");
	expect(
		await codeOf(client(http, { forbiddenPorts: [80] }).chat(request())),
	).toBe("larm_contract_mismatch");
	const https = fixture();
	claimingBase(https, "https://127.0.0.1/v1");
	expect(
		await codeOf(
			client(https, {
				baseUrl: () => "https://127.0.0.1:4500",
				forbiddenPorts: [443],
			}).chat(request()),
		),
	).toBe("larm_contract_mismatch");
	// Not forbidden: accepted.
	const open = fixture();
	claimingBase(open, "https://127.0.0.1/v1");
	await client(open, { baseUrl: () => "https://127.0.0.1:4500" }).chat(
		request(),
	);
	expect(open.calls.at(-1)!.url).toBe("https://127.0.0.1/v1/chat/completions");
});

test("a claim over http is refused when the control URL is https", async () => {
	const downgraded = fixture();
	claimingBase(downgraded, "http://127.0.0.1:4500/v1");
	expect(
		await codeOf(
			client(downgraded, { baseUrl: () => "https://127.0.0.1:4500" }).chat(
				request(),
			),
		),
	).toBe("larm_contract_mismatch");
	expect(downgraded.count("POST", "/v1/chat/completions")).toBe(0);
	const same = fixture();
	claimingBase(same, "https://127.0.0.1:4500/v1");
	await client(same, { baseUrl: () => "https://127.0.0.1:4500" }).chat(
		request(),
	);
	expect(same.calls.at(-1)!.url.startsWith("https://")).toBe(true);
});

/** Responses whose body never ends until `fail` is called; `tracker.cancelled` counts the cancelled ones. */
function hangingBody(status = 200) {
	const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
	const tracker = { cancelled: 0, made: 0 };
	return {
		response: () => {
			tracker.made++;
			return new Response(
				new ReadableStream<Uint8Array>({
					start(c) {
						controllers.push(c);
						c.enqueue(new TextEncoder().encode("{"));
					},
					cancel() {
						tracker.cancelled++;
					},
				}),
				{ status },
			);
		},
		fail: (reason: unknown) => controllers.forEach((c) => c.error(reason)),
		tracker,
	};
}

test("a caller's abort while the body is read is rethrown, not a contract mismatch", async () => {
	const fx = fixture();
	const hang = hangingBody();
	fx.state.chatRaw = hang.response;
	const abort = new AbortController();
	const pending = client(fx).chat(request({ signal: abort.signal }));
	const reason = new DOMException("aborted by the caller", "AbortError");
	const settled = pending.then(
		() => null,
		(error) => error,
	);
	await new Promise((resolve) => setTimeout(resolve, 20));
	abort.abort(reason);
	hang.fail(reason);
	const error = await settled;
	expect(error).not.toBeInstanceOf(LarmError);
	expect(error).toBe(reason);
});

test("a timeout while the body is read is larm_unreachable", async () => {
	const fx = fixture();
	const hang = hangingBody();
	fx.state.chatRaw = hang.response;
	const pending = codeOf(client(fx).chat(request()));
	await new Promise((resolve) => setTimeout(resolve, 20));
	hang.fail(new DOMException("timed out", "TimeoutError"));
	expect(await pending).toBe("larm_unreachable");
});

test("the body of a response that is not read is cancelled", async () => {
	for (const status of [500, 503, 401, 403]) {
		const fx = fixture();
		const hang = hangingBody(status);
		fx.state.chatRaw = hang.response;
		const code = await codeOf(client(fx).chat(request()));
		expect(code).toBe(status === 503 ? "larm_busy" : "larm_http_error");
		expect(hang.tracker.cancelled).toBe(hang.tracker.made);
		expect(hang.tracker.made).toBeGreaterThan(0);
	}
});
