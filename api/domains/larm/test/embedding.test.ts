import { expect, test } from "bun:test";
import {
	createLarmEmbedding,
	LARM_EMBEDDING_SPACE,
	LarmError,
	type LarmEmbeddingDeps,
	type LarmErrorCode,
} from "../index";

const BASE = "http://127.0.0.1:4500";
const CONTROL_TOKEN = "control-secret-456";
const CREDENTIAL = "credential-secret-123";
const CONNECTION_ID = "conn_01.A:b-c";

interface Call {
	method: string;
	url: string;
	headers: Record<string, string>;
	body: any;
}

interface Fixture {
	calls: Call[];
	sleeps: number[];
	clock: { now: number };
	fetch: typeof fetch;
	/** Behaviour switches, read on every request. */
	state: {
		createStatus: number;
		createRetryAfter: string | null;
		createBody: () => any;
		pollBodies: (() => any)[];
		pollStatus: number;
		claimStatus: number;
		claimBody: (n: number) => any;
		embedStatus: (n: number) => number;
		embedRetryAfter: string | null;
		embedBody: (texts: string[], type: string) => any;
		deleteStatus: number;
		failNetwork: boolean;
		credentialLifetimeMs: number;
	};
	count: (method: string, pathPart: string) => number;
}

const unit = (seed: number, dimension = 384) => {
	const v = Array.from({ length: dimension }, (_, i) => Math.sin(seed + i));
	const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
	return v.map((x) => x / norm);
};

const connectionBody = (
	status = "ready",
	readiness = "ready",
	claimable = true,
) => ({
	id: CONNECTION_ID,
	status,
	claimable,
	profile: "embeddingCanary",
	providers: [
		{
			name: "embedding",
			protocol: "larm.embedding.v1",
			endpoint: "/v1/embed",
			readiness,
			embeddingSpace: structuredClone(LARM_EMBEDDING_SPACE),
		},
	],
});

function fixture(): Fixture {
	const calls: Call[] = [];
	const clock = { now: Date.parse("2026-10-30T00:00:00.000Z") };
	let claims = 0;
	let embeds = 0;
	const state: Fixture["state"] = {
		createStatus: 201,
		createRetryAfter: null,
		createBody: () => connectionBody(),
		pollBodies: [],
		pollStatus: 200,
		claimStatus: 200,
		claimBody: () => ({}),
		embedStatus: () => 200,
		embedRetryAfter: null,
		embedBody: (texts, type) => ({
			dimension: 384,
			type,
			normalize: true,
			embeddings: texts.map((_, i) => unit(i + 1)),
		}),
		deleteStatus: 204,
		failNetwork: false,
		credentialLifetimeMs: 10 * 60_000,
	};
	state.claimBody = () => ({
		id: CONNECTION_ID,
		status: "ready",
		providers: [
			{
				protocol: "larm.embedding.v1",
				endpoint: `${BASE}/v1/embed`,
				configuration: { kind: "larm-embedding-provider-v1" },
				embeddingSpace: structuredClone(LARM_EMBEDDING_SPACE),
				credential: {
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
		if (method === "GET" && path === `/v1/agent-connections/${CONNECTION_ID}`) {
			const next = state.pollBodies.shift();
			return json(next ? next() : connectionBody(), state.pollStatus);
		}
		if (
			method === "POST" &&
			path === `/v1/agent-connections/${CONNECTION_ID}/claim`
		) {
			claims++;
			return json(state.claimBody(claims), state.claimStatus);
		}
		if (method === "POST" && path === "/v1/embed") {
			embeds++;
			const status = state.embedStatus(embeds);
			if (status !== 200)
				return json(
					{ error: `provider says ${CREDENTIAL}` },
					status,
					state.embedRetryAfter ? { "retry-after": state.embedRetryAfter } : {},
				);
			return json(state.embedBody(body.texts, body.type));
		}
		if (
			method === "DELETE" &&
			path === `/v1/agent-connections/${CONNECTION_ID}`
		)
			return new Response(null, { status: state.deleteStatus });
		return json({ error: "unexpected" }, 500);
	}) as unknown as typeof fetch;
	return {
		calls,
		sleeps: [],
		clock,
		fetch: fake,
		state,
		count: (method, part) =>
			calls.filter(
				(c) =>
					c.method === method &&
					decodeURIComponent(new URL(c.url).pathname).includes(part),
			).length,
	};
}

function client(fx: Fixture, over: Partial<LarmEmbeddingDeps> = {}) {
	return createLarmEmbedding({
		baseUrl: () => BASE,
		token: () => CONTROL_TOKEN,
		audience: () => null,
		profile: () => "embeddingCanary",
		fetch: fx.fetch,
		now: () => fx.clock.now,
		sleep: async (ms) => {
			fx.sleeps.push(ms);
		},
		...over,
	});
}

const creates = (fx: Fixture) =>
	fx.calls.filter(
		(c) =>
			c.method === "POST" &&
			new URL(c.url).pathname === "/v1/agent-connections",
	).length;

async function codeOf(promise: Promise<unknown>): Promise<LarmError> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(LarmError);
		return error as LarmError;
	}
	throw new Error("expected a LarmError");
}

test("connect, claim and embed in the order of the contract", async () => {
	const fx = fixture();
	const larm = client(fx);
	const vectors = await larm.embed(["alpha", "beta"], "passage");
	expect(vectors).toHaveLength(2);
	expect(vectors[0]).toBeInstanceOf(Float32Array);
	expect(vectors[0]!.length).toBe(384);
	expect(
		fx.calls.map(
			(c) => `${c.method} ${decodeURIComponent(new URL(c.url).pathname)}`,
		),
	).toEqual([
		"POST /v1/agent-connections",
		`POST /v1/agent-connections/${CONNECTION_ID}/claim`,
		"POST /v1/embed",
	]);
	const [create, claim, embed] = fx.calls;
	expect(create!.headers.authorization).toBe(`Bearer ${CONTROL_TOKEN}`);
	expect(create!.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
	expect(create!.headers.prefer).toBe("wait=1");
	expect(create!.body).toEqual({
		profile: "embeddingCanary",
		audience: "same-host",
		client: "contextstill",
		ttlSeconds: 300,
		allowFallback: false,
		deploymentPolicy: "existing-only",
	});
	expect(claim!.headers.authorization).toBe(`Bearer ${CONTROL_TOKEN}`);
	expect(claim!.body).toEqual({ format: "larm-embedding-provider-v1" });
	expect(embed!.url).toBe(`${BASE}/v1/embed`);
	expect(embed!.headers.authorization).toBe(`Bearer ${CREDENTIAL}`);
	// Plain text: no "passage: " prefix is added by the client.
	expect(embed!.body).toEqual({
		texts: ["alpha", "beta"],
		type: "passage",
		normalize: true,
		priority: "normal",
	});
	expect(larm.status()).toEqual({
		configured: true,
		tokenPresent: true,
		connection: "ready",
		lastError: null,
	});
});

test("a new Idempotency-Key per connection", async () => {
	const fx = fixture();
	const larm = client(fx);
	await larm.embed(["a"], "query");
	await larm.release();
	await larm.embed(["a"], "query");
	const keys = fx.calls
		.filter(
			(c) =>
				new URL(c.url).pathname === "/v1/agent-connections" &&
				c.method === "POST",
		)
		.map((c) => c.headers["idempotency-key"]);
	expect(keys).toHaveLength(2);
	expect(keys[0]).not.toBe(keys[1]);
});

test("the audience follows the base URL unless it is set", async () => {
	// A non-loopback host is not "same-host" (the fixture answers on its own origin only).
	const audiences: string[] = [];
	for (const [baseUrl, audience] of [
		["http://localhost:4500", null],
		["http://[::1]:4500", null],
		["http://127.0.0.1:4500", null],
		["https://larm.example.test", null],
		["http://127.0.0.1:4500", "saaa-desktop"],
	] as const) {
		const larm = createLarmEmbedding({
			baseUrl: () => baseUrl,
			token: () => CONTROL_TOKEN,
			audience: () => audience,
			profile: () => "embeddingCanary",
			fetch: (async (input: string | URL | Request, init?: RequestInit) => {
				const request = JSON.parse(String(init?.body ?? "{}"));
				audiences.push(request.audience);
				return new Response("{}", { status: 500 });
			}) as unknown as typeof fetch,
		});
		await codeOf(larm.embed(["x"], "query"));
	}
	expect(audiences).toEqual([
		"same-host",
		"same-host",
		"same-host",
		"saaa-desktop",
		"saaa-desktop",
	]);
});

test("a space that differs from larm-embedding.v1 is refused", async () => {
	for (const tamper of [
		(b: any) => (b.providers[0].embeddingSpace.dimension = 768),
		(b: any) => (b.providers[0].embeddingSpace.model.revision = "other"),
		(b: any) => (b.providers[0].embeddingSpace.prefixes.query = ""),
		(b: any) => (b.providers[0].name = "chat"),
		(b: any) => (b.providers[0].protocol = "larm.embedding.v2"),
		(b: any) => (b.providers[0].endpoint = "/v1/other"),
		(b: any) => (b.providers = []),
		(b: any) => b.providers.push(structuredClone(b.providers[0])),
		(b: any) => (b.id = "bad id!"),
	]) {
		const fx = fixture();
		fx.state.createBody = () => {
			const body = connectionBody();
			tamper(body);
			return body;
		};
		const error = await codeOf(client(fx).embed(["x"], "query"));
		expect(error.code).toBe("larm_embedding_space_mismatch");
	}
	// The claim is checked as well.
	const fx = fixture();
	const original = fx.state.claimBody;
	fx.state.claimBody = (n) => {
		const body = original(n);
		body.providers[0].embeddingSpace.dimension = 128;
		return body;
	};
	expect((await codeOf(client(fx).embed(["x"], "query"))).code).toBe(
		"larm_embedding_space_mismatch",
	);
	// The endpoint must be the absolute {base}/v1/embed.
	const fy = fixture();
	const originalClaim = fy.state.claimBody;
	fy.state.claimBody = (n) => {
		const body = originalClaim(n);
		body.providers[0].endpoint = "http://elsewhere.test/v1/embed";
		return body;
	};
	expect((await codeOf(client(fy).embed(["x"], "query"))).code).toBe(
		"larm_embedding_space_mismatch",
	);
	expect(fy.count("POST", "/v1/embed")).toBe(0);
});

test("409 is a provider conflict with Retry-After in milliseconds", async () => {
	const fx = fixture();
	fx.state.createStatus = 409;
	fx.state.createRetryAfter = "7";
	const error = await codeOf(client(fx).embed(["x"], "query"));
	expect(error.code).toBe("larm_provider_conflict");
	expect(error.retryAfterMs).toBe(7000);
	const noHeader = fixture();
	noHeader.state.createStatus = 409;
	expect(
		(await codeOf(client(noHeader).embed(["x"], "query"))).retryAfterMs,
	).toBeUndefined();
});

test("other control failures are larm_http_error; unreachable is larm_unreachable", async () => {
	const fx = fixture();
	fx.state.createStatus = 500;
	expect((await codeOf(client(fx).embed(["x"], "query"))).code).toBe(
		"larm_http_error",
	);
	const down = fixture();
	down.state.failNetwork = true;
	const error = await codeOf(client(down).embed(["x"], "query"));
	expect(error.code).toBe("larm_unreachable");
});

test("503 on embed is larm_busy: Retry-After, else 30 seconds", async () => {
	const fx = fixture();
	fx.state.embedStatus = () => 503;
	const dflt = await codeOf(client(fx).embed(["x"], "query"));
	expect(dflt.code).toBe("larm_busy");
	expect(dflt.retryAfterMs).toBe(30_000);
	const fy = fixture();
	fy.state.embedStatus = () => 503;
	fy.state.embedRetryAfter = "12";
	expect((await codeOf(client(fy).embed(["x"], "query"))).retryAfterMs).toBe(
		12_000,
	);
	// Busy does not make the client forget its connection.
	expect(creates(fy)).toBe(1);
});

test("no token and no base URL are told apart and send nothing", async () => {
	const fx = fixture();
	const noToken = client(fx, { token: () => undefined });
	expect((await codeOf(noToken.embed(["x"], "query"))).code).toBe(
		"larm_token_missing",
	);
	expect(noToken.status()).toEqual({
		configured: true,
		tokenPresent: false,
		connection: "error",
		lastError: "larm_token_missing",
	});
	const noBase = client(fx, { baseUrl: () => null });
	expect((await codeOf(noBase.embed(["x"], "query"))).code).toBe(
		"larm_not_configured",
	);
	expect(noBase.status().configured).toBe(false);
	const badBase = client(fx, { baseUrl: () => "ftp://x" });
	expect((await codeOf(badBase.embed(["x"], "query"))).code).toBe(
		"larm_not_configured",
	);
	expect(fx.calls).toHaveLength(0);
});

test("an embedding that breaks the contract is larm_contract_mismatch", async () => {
	const cases: ((texts: string[], type: string) => any)[] = [
		(texts, type) => ({
			dimension: 384,
			type,
			normalize: true,
			embeddings: texts.map(() => unit(1, 383)),
		}),
		(texts, type) => ({
			dimension: 384,
			type,
			normalize: true,
			embeddings: texts.map(() => unit(1).map((x) => x * 2)),
		}),
		(texts, type) => ({
			dimension: 384,
			type,
			normalize: true,
			embeddings: [],
		}),
		(texts, type) => ({
			dimension: 128,
			type,
			normalize: true,
			embeddings: texts.map(() => unit(1)),
		}),
		(texts, type) => ({
			dimension: 384,
			type,
			normalize: true,
			embeddings: texts.map(() =>
				unit(1).map((x, i) => (i === 3 ? Number.NaN : x)),
			),
		}),
		(texts, type) => ({
			dimension: 384,
			type,
			normalize: false,
			embeddings: texts.map(() => unit(1)),
		}),
		(texts) => ({
			dimension: 384,
			type: "other",
			normalize: true,
			embeddings: texts.map(() => unit(1)),
		}),
	];
	for (const body of cases) {
		const fx = fixture();
		fx.state.embedBody = body;
		const error = await codeOf(client(fx).embed(["x", "y"], "passage"));
		expect(error.code).toBe("larm_contract_mismatch");
	}
	// A non-JSON answer too.
	const fx = fixture();
	fx.state.embedBody = () => "not an object";
	expect((await codeOf(client(fx).embed(["x"], "query"))).code).toBe(
		"larm_contract_mismatch",
	);
});

test("the credential is reused until 30 seconds before it expires, then claimed again", async () => {
	const fx = fixture();
	fx.state.credentialLifetimeMs = 60_000;
	const larm = client(fx);
	await larm.embed(["a"], "query");
	fx.clock.now += 29_000;
	await larm.embed(["a"], "query");
	expect(fx.count("POST", "/claim")).toBe(1);
	fx.clock.now += 2_000; // 31 s in: 29 s left, inside the margin
	await larm.embed(["a"], "query");
	expect(fx.count("POST", "/claim")).toBe(2);
	// The connection itself is kept: no second create.
	expect(creates(fx)).toBe(1);
});

test("a refused credential (401/403) is replaced once, then it is an error", async () => {
	const fx = fixture();
	fx.state.embedStatus = (n) => (n === 1 ? 401 : 200);
	const larm = client(fx);
	expect(await larm.embed(["a"], "query")).toHaveLength(1);
	expect(fx.count("POST", "/claim")).toBe(2);
	expect(fx.count("POST", "/v1/embed")).toBe(2);
	const always = fixture();
	always.state.embedStatus = () => 403;
	expect((await codeOf(client(always).embed(["a"], "query"))).code).toBe(
		"larm_http_error",
	);
	expect(always.count("POST", "/claim")).toBe(2);
});

test("a connection that is not ready yet is polled three times, one second apart", async () => {
	const fx = fixture();
	fx.state.createStatus = 202;
	fx.state.createBody = () => connectionBody("provisioning", "starting", false);
	fx.state.pollBodies = [
		() => connectionBody("provisioning", "starting", false),
		() => connectionBody("provisioning", "starting", false),
		() => connectionBody("provisioning", "starting", false),
	];
	const larm = client(fx);
	expect((await codeOf(larm.embed(["a"], "query"))).code).toBe(
		"larm_deploying",
	);
	expect(fx.count("GET", CONNECTION_ID)).toBe(3);
	expect(fx.sleeps).toEqual([1000, 1000]);
	expect(fx.count("POST", "/claim")).toBe(0);
	// The next call keeps polling the same connection; ready on the second poll.
	fx.state.pollBodies = [
		() => connectionBody("provisioning", "starting", false),
		() => connectionBody(),
	];
	expect(await larm.embed(["a"], "query")).toHaveLength(1);
	expect(creates(fx)).toBe(1);
});

test("a released, expired or failed connection is dropped and rebuilt next time", async () => {
	for (const status of ["released", "expired", "failed"]) {
		const fx = fixture();
		fx.state.createBody = () =>
			connectionBody("provisioning", "starting", false);
		fx.state.pollBodies = [() => connectionBody(status, "ready", true)];
		const larm = client(fx);
		expect((await codeOf(larm.embed(["a"], "query"))).code).toBe(
			"larm_deploying",
		);
		fx.state.createBody = () => connectionBody();
		await larm.embed(["a"], "query");
		expect(creates(fx)).toBe(2);
	}
});

test("texts are sent in batches of maxBatch (16 by default)", async () => {
	const fx = fixture();
	const larm = client(fx);
	const texts = Array.from({ length: 40 }, (_, i) => `t${i}`);
	expect(await larm.embed(texts, "passage")).toHaveLength(40);
	const sizes = fx.calls
		.filter((c) => c.url === `${BASE}/v1/embed`)
		.map((c) => c.body.texts.length);
	expect(sizes).toEqual([16, 16, 8]);
	const small = fixture();
	await client(small, { maxBatch: 5 }).embed(texts.slice(0, 12), "query");
	expect(
		small.calls
			.filter((c) => c.url === `${BASE}/v1/embed`)
			.map((c) => c.body.texts.length),
	).toEqual([5, 5, 2]);
	expect(await client(fixture()).embed([], "query")).toEqual([]);
});

test("release deletes the connection and the next embed builds a new one", async () => {
	const fx = fixture();
	const larm = client(fx);
	await larm.release(); // nothing to release
	expect(fx.calls).toHaveLength(0);
	await larm.embed(["a"], "query");
	await larm.release();
	const last = fx.calls.at(-1)!;
	expect(last.method).toBe("DELETE");
	expect(decodeURIComponent(new URL(last.url).pathname)).toBe(
		`/v1/agent-connections/${CONNECTION_ID}`,
	);
	expect(last.headers.authorization).toBe(`Bearer ${CONTROL_TOKEN}`);
	expect(larm.status().connection).toBe("none");
	await larm.embed(["a"], "query");
	expect(creates(fx)).toBe(2);
	// A failed release is reported but the local state is cleared.
	fx.state.deleteStatus = 500;
	expect((await codeOf(larm.release())).code).toBe("larm_http_error");
	expect(larm.status().connection).toBe("error");
});

test("neither token ever appears in an error, a status or a message", async () => {
	const failures: ((fx: Fixture) => void)[] = [
		(fx) => (fx.state.createStatus = 500),
		(fx) => (fx.state.createStatus = 409),
		(fx) => (fx.state.failNetwork = true),
		(fx) => (fx.state.embedStatus = () => 503),
		(fx) => (fx.state.embedStatus = () => 500),
		(fx) => (fx.state.embedBody = () => ({ dimension: 1, leaked: CREDENTIAL })),
		(fx) => (fx.state.claimStatus = 500),
	];
	for (const setup of failures) {
		const fx = fixture();
		setup(fx);
		const larm = client(fx);
		const error = await codeOf(larm.embed(["x"], "query"));
		const everything = JSON.stringify([
			error.message,
			error.code,
			error.retryAfterMs,
			String(error),
			error.stack?.split("\n")[0],
			larm.status(),
		]);
		expect(everything).not.toContain(CREDENTIAL);
		expect(everything).not.toContain(CONTROL_TOKEN);
		expect(error.message).toBe(error.code as LarmErrorCode);
	}
	// A success carries no token either.
	const fx = fixture();
	const larm = client(fx);
	await larm.embed(["x"], "query");
	expect(JSON.stringify(larm.status())).not.toContain(CREDENTIAL);
});

test("an aborted call surfaces the abort, not a LARM error", async () => {
	const fx = fixture();
	const controller = new AbortController();
	const abortingFetch = (async () => {
		controller.abort(new Error("caller_aborted"));
		throw new Error("aborted");
	}) as unknown as typeof fetch;
	const larm = client(fx, { fetch: abortingFetch });
	await expect(
		larm.embed(["x"], "query", { signal: controller.signal }),
	).rejects.toThrow("aborted");
});

test("a changed token, profile, audience or base URL makes a new connection and credential", async () => {
	const fx = fixture();
	const config = {
		base: BASE,
		token: CONTROL_TOKEN,
		profile: "embeddingCanary",
		audience: null as "same-host" | "saaa-desktop" | null,
	};
	const larm = client(fx, {
		baseUrl: () => config.base,
		token: () => config.token,
		profile: () => config.profile,
		audience: () => config.audience,
	});
	await larm.embed(["a"], "query");
	await larm.embed(["a"], "query");
	expect(creates(fx)).toBe(1);

	config.token = "another-control-secret";
	await larm.embed(["a"], "query");
	expect(creates(fx)).toBe(2);
	expect(
		fx.calls.filter((c) => c.method === "POST").at(-3)!.headers.authorization,
	).toBe("Bearer another-control-secret");

	config.profile = "otherProfile";
	await larm.embed(["a"], "query");
	expect(creates(fx)).toBe(3);
	expect(
		fx.calls
			.filter((c) => new URL(c.url).pathname === "/v1/agent-connections")
			.at(-1)!.body.profile,
	).toBe("otherProfile");

	config.audience = "saaa-desktop";
	await larm.embed(["a"], "query");
	expect(creates(fx)).toBe(4);

	config.base = "http://127.0.0.1:4501";
	const claimBody = fx.state.claimBody;
	fx.state.claimBody = (n) => {
		const body = claimBody(n);
		body.providers[0].endpoint = "http://127.0.0.1:4501/v1/embed";
		return body;
	};
	await larm.embed(["a"], "query");
	expect(creates(fx)).toBe(5);
	expect(fx.calls.at(-1)!.url).toBe("http://127.0.0.1:4501/v1/embed");
	// Unchanged settings keep reusing the latest connection.
	await larm.embed(["a"], "query");
	expect(creates(fx)).toBe(5);
});

test("release after a settings change does not speak for the old connection", async () => {
	const fx = fixture();
	let token = CONTROL_TOKEN;
	const larm = client(fx, { token: () => token });
	await larm.embed(["a"], "query");
	token = "another-control-secret";
	await larm.release();
	expect(fx.count("DELETE", "/v1/agent-connections")).toBe(0);
	await larm.embed(["a"], "query");
	expect(creates(fx)).toBe(2);
});

test("the shared connect does not run on the first caller's signal", async () => {
	const fx = fixture();
	let open!: () => void;
	const gate = new Promise<void>((resolve) => {
		open = resolve;
	});
	const gated = (async (input: string | URL | Request, init?: RequestInit) => {
		if (
			init?.method === "POST" &&
			String(input).endsWith("/v1/agent-connections")
		)
			await gate;
		return fx.fetch(input, init);
	}) as typeof fetch;
	const larm = client(fx, { fetch: gated });
	const first = new AbortController();
	const a = larm.embed(["a"], "query", { signal: first.signal });
	const b = larm.embed(["b"], "query");
	first.abort(new Error("first_gave_up"));
	await expect(a).rejects.toThrow("first_gave_up");
	open();
	expect(await b).toHaveLength(1);
	expect(creates(fx)).toBe(1);
});

test("a response larger than 8 MiB is refused while streaming, not after reading it all", async () => {
	const fx = fixture();
	let pulled = 0;
	const chunk = new Uint8Array(1024 * 1024).fill(32);
	const huge = (async () =>
		new Response(
			new ReadableStream<Uint8Array>({
				pull(controller) {
					pulled++;
					if (pulled > 200) controller.close();
					else controller.enqueue(chunk);
				},
			}),
			{ status: 201 },
		)) as unknown as typeof fetch;
	const larm = client(fx, { fetch: huge });
	const error = await codeOf(larm.embed(["a"], "query"));
	expect(error.code).toBe("larm_contract_mismatch");
	expect(pulled).toBeLessThan(20);
	// A declared length over the limit is refused without reading.
	const declared = (async () =>
		new Response("{}", {
			status: 201,
			headers: { "content-length": String(9 * 1024 * 1024) },
		})) as unknown as typeof fetch;
	const again = await codeOf(
		client(fx, { fetch: declared }).embed(["a"], "query"),
	);
	expect(again.code).toBe("larm_contract_mismatch");
});
