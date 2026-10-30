import { sha256Hex } from "../../../infrastructure/digest";
import {
	LarmError,
	type LarmEmbeddingStatus,
	type LarmEmbeddingDeps,
	type LarmErrorCode,
} from "../contracts";

/**
 * The part of a LARM client that does not depend on the provider kind: the Agent Connection
 * (create, poll until ready, claim, release), the HTTP plumbing and the status. The embedding and
 * the chat client each give a `ConnectionSpec` for what differs (profile, provider checks, claim).
 */

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;
const CREDENTIAL_MARGIN_MS = 30_000;
const READY_ATTEMPTS = 3;
const READY_INTERVAL_MS = 1000;
/** Control responses (create, poll, claim) are never larger than this. */
const MAX_CONTROL_BYTES = 8 * 1024 * 1024;

export type Json = Record<string, unknown>;
export const isObject = (value: unknown): value is Json =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Retry-After in seconds to milliseconds; absent or unreadable gives `fallback`. */
export function retryAfter(
	response: Response,
	fallback?: number,
): number | undefined {
	const raw = response.headers.get("retry-after");
	const seconds = raw === null ? Number.NaN : Number(raw.trim());
	return Number.isFinite(seconds) && seconds >= 0
		? Math.round(seconds * 1000)
		: fallback;
}

export function isLoopbackHost(hostname: string): boolean {
	return (
		hostname === "localhost" ||
		hostname === "[::1]" ||
		hostname === "::1" ||
		/^127(\.\d{1,3}){3}$/.test(hostname)
	);
}

export interface ProviderCheck {
	/** The provider entry of the response. */
	first: Json;
	/** What must stay the same across polls and claim (the chat model; "" when there is none). */
	pin: string;
}

export interface ParsedClaim<T> {
	target: T;
	token: string;
	expiresAtMs: number;
}

export interface ConnectionSpec<T> {
	/** The profile to ask for. */
	profile(): string;
	/** Added to the create request (for example `providers`). */
	createExtra?: Json;
	/** The code of a create or poll response that does not describe the expected provider. */
	mismatchCode: LarmErrorCode;
	/** Checks the provider of a create or poll response; a code means rejected. */
	provider(
		body: Json,
		ctx: { profile: string; audience: string },
	): ProviderCheck | LarmErrorCode;
	/** The `format` sent with the claim. */
	claimFormat: string;
	/** Checks the claim and takes the target and credential out of it; a code means rejected. */
	parseClaim(
		body: Json,
		ctx: { base: URL; connectionId: string; pin: string },
	): ParsedClaim<T> | LarmErrorCode;
}

interface Connection<T> {
	id: string;
	/** Digest of the settings this connection was made with; the token itself is not kept for it. */
	key: string;
	pin: string;
	/** The last status read from LARM said ready and claimable. */
	ready: boolean;
	credential: { token: string; expiresAtMs: number } | null;
	target: T | null;
}

export interface LarmConnection<T> {
	fail(code: LarmErrorCode, retryAfterMs?: number): never;
	/** Throws the error after cancelling the body of a response that is not going to be read. */
	reject(
		response: Response,
		code: LarmErrorCode,
		retryAfterMs?: number,
	): Promise<never>;
	request(
		url: string,
		init: {
			method: string;
			token: string;
			body?: unknown;
			headers?: Record<string, string>;
		},
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<Response>;
	/** Reads a JSON object body; stops as soon as it is larger than `limit` and fails with `overCode`. */
	readJson(
		response: Response,
		limit?: number,
		overCode?: LarmErrorCode,
	): Promise<Json>;
	/** Target and credential of a ready connection; connects and claims as needed. */
	acquire(
		signal?: AbortSignal,
		forceClaim?: boolean,
	): Promise<{ target: T; token: string }>;
	/** The credential was refused: claim again on the next `acquire`. */
	dropCredential(): void;
	/** The target of the current claim, when there is one. */
	currentTarget(): T | null;
	markHealthy(): void;
	status(): LarmEmbeddingStatus;
	release(): Promise<void>;
}

export function createLarmConnection<T>(
	deps: LarmEmbeddingDeps,
	spec: ConnectionSpec<T>,
): LarmConnection<T> {
	const sleep =
		deps.sleep ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const now = deps.now ?? (() => Date.now());
	const controlTimeoutMs = deps.controlTimeoutMs ?? 10_000;

	let connection: Connection<T> | null = null;
	let lastError: LarmErrorCode | null = null;
	let connecting: Promise<{ target: T; token: string }> | null = null;
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

	/** The caller's own signal of each response, to tell its abort from a timeout while reading. */
	const callerSignals = new WeakMap<Response, AbortSignal | undefined>();

	async function reject(
		response: Response,
		code: LarmErrorCode,
		retryAfterMs?: number,
	): Promise<never> {
		await response.body?.cancel().catch(() => {});
		return fail(code, retryAfterMs);
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
			const response = await deps.fetch(url, {
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
			callerSignals.set(response, signal);
			return response;
		} catch (error) {
			if (signal?.aborted) throw error;
			return fail("larm_unreachable");
		}
	}

	/** Reads the body as a stream and stops as soon as it is larger than the limit. */
	async function readJson(
		response: Response,
		limit = MAX_CONTROL_BYTES,
		overCode: LarmErrorCode = "larm_contract_mismatch",
	): Promise<Json> {
		try {
			const declared = Number(response.headers.get("content-length"));
			if (Number.isFinite(declared) && declared > limit) {
				await response.body?.cancel().catch(() => {});
				return fail(overCode);
			}
			const chunks: Uint8Array[] = [];
			let size = 0;
			const reader = response.body?.getReader();
			while (reader) {
				const { done, value } = await reader.read();
				if (done) break;
				size += value.byteLength;
				if (size > limit) {
					await reader.cancel().catch(() => {});
					return fail(overCode);
				}
				chunks.push(value);
			}
			const text = new TextDecoder().decode(Buffer.concat(chunks));
			const value: unknown = JSON.parse(text);
			if (isObject(value)) return value;
		} catch (error) {
			if (error instanceof LarmError) throw error;
			// The caller gave up: that is not a bad body. A timeout is the server being unreachable.
			if (callerSignals.get(response)?.aborted) throw error;
			if (
				error instanceof DOMException &&
				(error.name === "AbortError" || error.name === "TimeoutError")
			)
				return fail("larm_unreachable");
		}
		return fail("larm_contract_mismatch");
	}

	/** The one provider of a connection response, after the contract checks. */
	function checkedProvider(body: Json, base: URL): ProviderCheck {
		if (typeof body.id !== "string" || !ID_PATTERN.test(body.id))
			return fail(spec.mismatchCode);
		const checked = spec.provider(body, {
			profile: spec.profile(),
			audience: audienceFor(base),
		});
		return typeof checked === "string" ? fail(checked) : checked;
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
	): Promise<Connection<T>> {
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
					profile: spec.profile(),
					audience: audienceFor(base),
					client: "contextstill",
					ttlSeconds: 300,
					allowFallback: false,
					deploymentPolicy: "existing-only",
					...spec.createExtra,
				},
			},
			controlTimeoutMs,
			signal,
		);
		if (created.status === 409)
			return reject(created, "larm_provider_conflict", retryAfter(created));
		if (created.status !== 201 && created.status !== 202)
			return reject(created, "larm_http_error");
		const body = await readJson(created);
		const { first, pin } = checkedProvider(body, base);
		// Kept even when not ready yet: the next call waits for this one instead of creating another.
		return {
			id: body.id as string,
			key,
			pin,
			ready: isReady(body, first),
			credential: null,
			target: null,
		};
	}

	/** Polls the connection (up to three times, one second apart) until it is ready and claimable. */
	async function ensureReady(
		base: URL,
		token: string,
		current: Connection<T>,
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
				return reject(polled, "larm_deploying");
			}
			if (polled.status !== 200) return reject(polled, "larm_http_error");
			const body = await readJson(polled);
			const { first, pin } = checkedProvider(body, base);
			if (body.id !== current.id || pin !== current.pin)
				return fail("larm_contract_mismatch");
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
		current: Connection<T>,
		signal?: AbortSignal,
	): Promise<{ target: T; token: string }> {
		const response = await request(
			new URL(
				`/v1/agent-connections/${encodeURIComponent(current.id)}/claim`,
				base,
			).toString(),
			{
				method: "POST",
				token,
				body: { format: spec.claimFormat },
			},
			controlTimeoutMs,
			signal,
		);
		if (response.status === 404 || response.status === 410) {
			discard();
			return reject(response, "larm_deploying");
		}
		if (response.status !== 200) return reject(response, "larm_http_error");
		const parsed = spec.parseClaim(await readJson(response), {
			base,
			connectionId: current.id,
			pin: current.pin,
		});
		if (typeof parsed === "string") return fail(parsed);
		current.credential = {
			token: parsed.token,
			expiresAtMs: parsed.expiresAtMs,
		};
		current.target = parsed.target;
		return { target: parsed.target, token: parsed.token };
	}

	/** What a connection depends on: URL, audience, profile and (as a digest) the control token. */
	function settingsKey(base: URL, token: string): string {
		return sha256Hex(
			JSON.stringify([
				base.toString(),
				audienceFor(base),
				spec.profile(),
				sha256Hex(token),
			]),
		);
	}

	/** Waits for `promise`, or stops waiting (the work goes on) when `signal` aborts. */
	function waitFor<V>(promise: Promise<V>, signal?: AbortSignal): Promise<V> {
		if (!signal) return promise;
		if (signal.aborted) return Promise.reject(signal.reason);
		return new Promise<V>((resolve, reject) => {
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
	 * Target and credential of a ready connection; connects and claims as needed. The shared
	 * connect runs on its own (never on a caller's signal): each caller waits with its own signal.
	 */
	async function acquire(
		signal?: AbortSignal,
		forceClaim = false,
	): Promise<{ target: T; token: string }> {
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
					connection.target !== null &&
					connection.credential.expiresAtMs - CREDENTIAL_MARGIN_MS > now()
				)
					return {
						target: connection.target,
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

	return {
		fail,
		reject,
		request,
		readJson,
		acquire,
		dropCredential() {
			if (connection) connection.credential = null;
		},
		currentTarget() {
			return connection?.credential ? connection.target : null;
		},
		markHealthy() {
			lastError = null;
		},
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
				return reject(response, "larm_http_error");
			await response.body?.cancel().catch(() => {});
		},
	};
}
