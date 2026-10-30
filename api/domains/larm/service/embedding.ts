import { canonicalJson, sha256Hex } from "../../../infrastructure/digest";
import {
	type EmbeddingInputType,
	LARM_EMBEDDING_SPACE,
	LarmError,
	type LarmEmbeddingClient,
	type LarmEmbeddingDeps,
	type LarmErrorCode,
} from "../contracts";

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;
const SPACE_JSON = canonicalJson(LARM_EMBEDDING_SPACE);
const CREDENTIAL_MARGIN_MS = 30_000;
const READY_ATTEMPTS = 3;
const READY_INTERVAL_MS = 1000;
const DEFAULT_BUSY_RETRY_MS = 30_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
	typeof value === "object" && value !== null && !Array.isArray(value);

interface Connection {
	id: string;
	/** Digest of the settings this connection was made with; the token itself is not kept for it. */
	key: string;
	/** The last status read from LARM said ready and claimable. */
	ready: boolean;
	credential: { token: string; expiresAtMs: number } | null;
}

/** Retry-After in seconds to milliseconds; absent or unreadable gives `fallback`. */
function retryAfter(response: Response, fallback?: number): number | undefined {
	const raw = response.headers.get("retry-after");
	const seconds = raw === null ? Number.NaN : Number(raw.trim());
	return Number.isFinite(seconds) && seconds >= 0
		? Math.round(seconds * 1000)
		: fallback;
}

function isLoopbackHost(hostname: string): boolean {
	return (
		hostname === "localhost" ||
		hostname === "[::1]" ||
		hostname === "::1" ||
		/^127(\.\d{1,3}){3}$/.test(hostname)
	);
}

export function createLarmEmbedding(
	deps: LarmEmbeddingDeps,
): LarmEmbeddingClient {
	const now = deps.now ?? (() => Date.now());
	const sleep =
		deps.sleep ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const controlTimeoutMs = deps.controlTimeoutMs ?? 10_000;
	const embedTimeoutMs = deps.embedTimeoutMs ?? 30_000;
	const maxBatch = Math.max(1, deps.maxBatch ?? 16);

	let connection: Connection | null = null;
	let lastError: LarmErrorCode | null = null;
	let connecting: Promise<{ endpoint: string; token: string }> | null = null;
	let connectingKey = "";

	const fail = (code: LarmErrorCode, retryAfterMs?: number): never => {
		lastError = code;
		throw new LarmError(code, retryAfterMs);
	};

	/** The configured control origin, or the reason it cannot be used. */
	function origin(): { base: URL; token: string } {
		const configured = deps.baseUrl();
		if (!configured) return fail("larm_not_configured");
		let base: URL;
		try {
			base = new URL(configured);
		} catch {
			return fail("larm_not_configured");
		}
		if (base.protocol !== "http:" && base.protocol !== "https:")
			return fail("larm_not_configured");
		const token = deps.token();
		if (!token) return fail("larm_token_missing");
		return { base, token };
	}

	function audienceFor(base: URL): "same-host" | "saaa-desktop" {
		return (
			deps.audience() ??
			(isLoopbackHost(base.hostname) ? "same-host" : "saaa-desktop")
		);
	}

	async function request(
		url: string,
		init: {
			method: string;
			token: string;
			body?: unknown;
			headers?: Record<string, string>;
		},
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<Response> {
		const timeout = AbortSignal.timeout(timeoutMs);
		try {
			return await deps.fetch(url, {
				method: init.method,
				headers: {
					authorization: `Bearer ${init.token}`,
					...(init.body === undefined
						? {}
						: { "content-type": "application/json" }),
					...init.headers,
				},
				body: init.body === undefined ? undefined : JSON.stringify(init.body),
				redirect: "error",
				signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
			});
		} catch (error) {
			if (signal?.aborted) throw error;
			return fail("larm_unreachable");
		}
	}

	/** Reads the body as a stream and stops as soon as it is larger than the limit. */
	async function readJson(response: Response): Promise<Json> {
		try {
			const declared = Number(response.headers.get("content-length"));
			if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
				await response.body?.cancel().catch(() => {});
				return fail("larm_contract_mismatch");
			}
			const chunks: Uint8Array[] = [];
			let size = 0;
			const reader = response.body?.getReader();
			while (reader) {
				const { done, value } = await reader.read();
				if (done) break;
				size += value.byteLength;
				if (size > MAX_RESPONSE_BYTES) {
					await reader.cancel().catch(() => {});
					return fail("larm_contract_mismatch");
				}
				chunks.push(value);
			}
			const text = new TextDecoder().decode(Buffer.concat(chunks));
			const value: unknown = JSON.parse(text);
			if (isObject(value)) return value;
		} catch (error) {
			if (error instanceof LarmError) throw error;
		}
		return fail("larm_contract_mismatch");
	}

	/** The one embedding provider of a connection response, after the contract checks. */
	function provider(body: Json): Json {
		const providers = body.providers;
		const first = Array.isArray(providers) ? providers[0] : undefined;
		if (
			typeof body.id !== "string" ||
			!ID_PATTERN.test(body.id) ||
			!Array.isArray(providers) ||
			providers.length !== 1 ||
			!isObject(first) ||
			first.name !== "embedding" ||
			first.protocol !== "larm.embedding.v1" ||
			first.endpoint !== "/v1/embed" ||
			!isObject(first.embeddingSpace) ||
			canonicalJson(first.embeddingSpace) !== SPACE_JSON
		)
			return fail("larm_embedding_space_mismatch");
		return first;
	}

	function isReady(body: Json, first: Json): boolean {
		return (
			body.status === "ready" &&
			first.readiness === "ready" &&
			(body.claimable ?? first.claimable) === true
		);
	}

	const discard = () => {
		connection = null;
	};

	async function establish(
		base: URL,
		token: string,
		key: string,
		signal?: AbortSignal,
	): Promise<Connection> {
		const created = await request(
			new URL("/v1/agent-connections", base).toString(),
			{
				method: "POST",
				token,
				headers: {
					"idempotency-key": crypto.randomUUID(),
					prefer: "wait=1",
				},
				body: {
					profile: deps.profile(),
					audience: audienceFor(base),
					client: "contextstill",
					ttlSeconds: 300,
					allowFallback: false,
					deploymentPolicy: "existing-only",
				},
			},
			controlTimeoutMs,
			signal,
		);
		if (created.status === 409)
			return fail("larm_provider_conflict", retryAfter(created));
		if (created.status !== 201 && created.status !== 202)
			return fail("larm_http_error");
		const body = await readJson(created);
		const first = provider(body);
		// Kept even when not ready yet: the next call waits for this one instead of creating another.
		return {
			id: body.id as string,
			key,
			ready: isReady(body, first),
			credential: null,
		};
	}

	/** Polls the connection (up to three times, one second apart) until it is ready and claimable. */
	async function ensureReady(
		base: URL,
		token: string,
		current: Connection,
		signal?: AbortSignal,
	): Promise<void> {
		for (let attempt = 0; !current.ready; attempt++) {
			if (attempt >= READY_ATTEMPTS) return fail("larm_deploying");
			if (attempt > 0) await sleep(READY_INTERVAL_MS);
			const polled = await request(
				new URL(
					`/v1/agent-connections/${encodeURIComponent(current.id)}`,
					base,
				).toString(),
				{ method: "GET", token },
				controlTimeoutMs,
				signal,
			);
			if (polled.status === 404 || polled.status === 410) {
				discard();
				return fail("larm_deploying");
			}
			if (polled.status !== 200) return fail("larm_http_error");
			const body = await readJson(polled);
			const first = provider(body);
			if (body.id !== current.id) return fail("larm_contract_mismatch");
			if (
				body.status === "released" ||
				body.status === "expired" ||
				body.status === "failed"
			) {
				// Dropped; the next call builds a new connection.
				discard();
				return fail("larm_deploying");
			}
			current.ready = isReady(body, first);
		}
	}

	async function claim(
		base: URL,
		token: string,
		current: Connection,
		signal?: AbortSignal,
	): Promise<{ endpoint: string; token: string }> {
		const response = await request(
			new URL(
				`/v1/agent-connections/${encodeURIComponent(current.id)}/claim`,
				base,
			).toString(),
			{
				method: "POST",
				token,
				body: { format: "larm-embedding-provider-v1" },
			},
			controlTimeoutMs,
			signal,
		);
		if (response.status === 404 || response.status === 410) {
			discard();
			return fail("larm_deploying");
		}
		if (response.status !== 200) return fail("larm_http_error");
		const body = await readJson(response);
		const providers = body.providers;
		const first = Array.isArray(providers) ? providers[0] : undefined;
		const expected = new URL("/v1/embed", base).toString();
		if (
			!Array.isArray(providers) ||
			providers.length !== 1 ||
			!isObject(first) ||
			!isObject(first.configuration) ||
			first.configuration.kind !== "larm-embedding-provider-v1" ||
			first.endpoint !== expected ||
			!isObject(first.embeddingSpace) ||
			canonicalJson(first.embeddingSpace) !== SPACE_JSON
		)
			return fail("larm_embedding_space_mismatch");
		const credential = first.credential;
		const secret = isObject(credential) ? credential.token : undefined;
		const expiresAt = isObject(credential) ? credential.expiresAt : undefined;
		const expiresAtMs =
			typeof expiresAt === "string" ? Date.parse(expiresAt) : Number.NaN;
		if (
			typeof secret !== "string" ||
			secret === "" ||
			Number.isNaN(expiresAtMs)
		)
			return fail("larm_contract_mismatch");
		current.credential = { token: secret, expiresAtMs };
		return { endpoint: expected, token: secret };
	}

	/** What a connection depends on: URL, audience, profile and (as a digest) the control token. */
	function settingsKey(base: URL, token: string): string {
		return sha256Hex(
			JSON.stringify([
				base.toString(),
				audienceFor(base),
				deps.profile(),
				sha256Hex(token),
			]),
		);
	}

	/** Waits for `promise`, or stops waiting (the work goes on) when `signal` aborts. */
	function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
		if (!signal) return promise;
		if (signal.aborted) return Promise.reject(signal.reason);
		return new Promise<T>((resolve, reject) => {
			const onAbort = () => reject(signal.reason);
			signal.addEventListener("abort", onAbort, { once: true });
			promise.then(
				(value) => {
					signal.removeEventListener("abort", onAbort);
					resolve(value);
				},
				(error) => {
					signal.removeEventListener("abort", onAbort);
					reject(error);
				},
			);
		});
	}

	/**
	 * Endpoint and credential of a ready connection; connects and claims as needed. The shared
	 * connect runs on its own (never on a caller's signal): each caller waits with its own signal.
	 */
	async function acquire(
		signal?: AbortSignal,
		forceClaim = false,
	): Promise<{ endpoint: string; token: string }> {
		const { base, token } = origin();
		const key = settingsKey(base, token);
		// A connect for other settings is not joined; wait for it, then build for these.
		while (connecting && connectingKey !== key) {
			await waitFor(
				connecting.then(
					() => undefined,
					() => undefined,
				),
				signal,
			);
		}
		if (!connecting) {
			connectingKey = key;
			const run = (async () => {
				// Settings changed since this connection was made: its URL, audience, profile
				// or credential no longer apply.
				if (connection && connection.key !== key) discard();
				if (forceClaim && connection) connection.credential = null;
				if (
					connection?.credential &&
					connection.credential.expiresAtMs - CREDENTIAL_MARGIN_MS > now()
				)
					return {
						endpoint: new URL("/v1/embed", base).toString(),
						token: connection.credential.token,
					};
				connection ??= await establish(base, token, key);
				await ensureReady(base, token, connection);
				const claimed = await claim(base, token, connection);
				lastError = null;
				return claimed;
			})();
			const shared = run.finally(() => {
				if (connecting === shared) connecting = null;
			});
			// Nobody may be waiting any more; the failure is then simply dropped.
			shared.catch(() => {});
			connecting = shared;
		}
		return waitFor(connecting!, signal);
	}

	async function embedChunk(
		texts: string[],
		type: EmbeddingInputType,
		signal?: AbortSignal,
	): Promise<Float32Array[]> {
		for (let attempt = 0; ; attempt++) {
			const target = await acquire(signal, attempt > 0);
			const response = await request(
				target.endpoint,
				{
					method: "POST",
					token: target.token,
					body: { texts, type, normalize: true, priority: "normal" },
				},
				embedTimeoutMs,
				signal,
			);
			if (response.status === 503)
				return fail("larm_busy", retryAfter(response, DEFAULT_BUSY_RETRY_MS));
			if (response.status === 401 || response.status === 403) {
				// The credential was refused: drop it and claim again, once.
				if (connection) connection.credential = null;
				if (attempt === 0) continue;
				return fail("larm_http_error");
			}
			if (response.status !== 200) return fail("larm_http_error");
			const vectors = validateEmbeddings(
				await readJson(response),
				texts.length,
				type,
			);
			lastError = null;
			return vectors;
		}
	}

	function validateEmbeddings(
		body: Json,
		count: number,
		type: EmbeddingInputType,
	): Float32Array[] {
		const dimension = LARM_EMBEDDING_SPACE.dimension;
		const rows = body.embeddings;
		if (
			body.dimension !== dimension ||
			body.type !== type ||
			body.normalize !== true ||
			!Array.isArray(rows) ||
			rows.length !== count
		)
			return fail("larm_contract_mismatch");
		return rows.map((row) => {
			if (!Array.isArray(row) || row.length !== dimension)
				return fail("larm_contract_mismatch");
			const vector = new Float32Array(dimension);
			let sum = 0;
			for (let i = 0; i < dimension; i++) {
				const value = row[i];
				if (typeof value !== "number" || !Number.isFinite(value))
					return fail("larm_contract_mismatch");
				vector[i] = value;
				sum += value * value;
			}
			if (Math.abs(Math.sqrt(sum) - 1) > 1e-3)
				return fail("larm_contract_mismatch");
			return vector;
		});
	}

	return {
		status() {
			const configured = deps.baseUrl() !== null;
			return {
				configured,
				tokenPresent: !!deps.token(),
				connection: connection?.credential
					? "ready"
					: lastError
						? "error"
						: "none",
				lastError,
			};
		},
		async embed(texts, type, opts) {
			const vectors: Float32Array[] = [];
			for (let i = 0; i < texts.length; i += maxBatch)
				vectors.push(
					...(await embedChunk(
						texts.slice(i, i + maxBatch),
						type,
						opts?.signal,
					)),
				);
			return vectors;
		},
		async release() {
			const current = connection;
			if (!current) return;
			discard();
			const { base, token } = origin();
			// Made under other settings: this URL and token cannot speak for it; it lapses by its TTL.
			if (current.key !== settingsKey(base, token)) return;
			const response = await request(
				new URL(
					`/v1/agent-connections/${encodeURIComponent(current.id)}`,
					base,
				).toString(),
				{ method: "DELETE", token },
				controlTimeoutMs,
			);
			// 404: LARM already forgot the connection.
			if (response.status !== 204 && response.status !== 404)
				fail("larm_http_error");
		},
	};
}
