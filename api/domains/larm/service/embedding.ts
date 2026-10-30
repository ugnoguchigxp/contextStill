import { canonicalJson } from "../../../infrastructure/digest";
import {
	type EmbeddingInputType,
	LARM_EMBEDDING_SPACE,
	type LarmEmbeddingClient,
	type LarmEmbeddingDeps,
} from "../contracts";
import {
	createLarmConnection,
	isObject,
	retryAfter,
	type Json,
} from "./connection";

const SPACE_JSON = canonicalJson(LARM_EMBEDDING_SPACE);
const DEFAULT_BUSY_RETRY_MS = 30_000;

export function createLarmEmbedding(
	deps: LarmEmbeddingDeps,
): LarmEmbeddingClient {
	const embedTimeoutMs = deps.embedTimeoutMs ?? 30_000;
	const maxBatch = Math.max(1, deps.maxBatch ?? 16);

	const link = createLarmConnection<{ endpoint: string }>(deps, {
		profile: deps.profile,
		mismatchCode: "larm_embedding_space_mismatch",
		provider(body) {
			const providers = body.providers;
			const first = Array.isArray(providers) ? providers[0] : undefined;
			if (
				!Array.isArray(providers) ||
				providers.length !== 1 ||
				!isObject(first) ||
				first.name !== "embedding" ||
				first.protocol !== "larm.embedding.v1" ||
				first.endpoint !== "/v1/embed" ||
				!isObject(first.embeddingSpace) ||
				canonicalJson(first.embeddingSpace) !== SPACE_JSON
			)
				return "larm_embedding_space_mismatch";
			return { first, pin: "" };
		},
		claimFormat: "larm-embedding-provider-v1",
		parseClaim(body, { base }) {
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
				return "larm_embedding_space_mismatch";
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
				return "larm_contract_mismatch";
			return { target: { endpoint: expected }, token: secret, expiresAtMs };
		},
	});
	const { fail } = link;

	async function embedChunk(
		texts: string[],
		type: EmbeddingInputType,
		signal?: AbortSignal,
	): Promise<Float32Array[]> {
		for (let attempt = 0; ; attempt++) {
			const target = await link.acquire(signal, attempt > 0);
			const response = await link.request(
				target.target.endpoint,
				{
					method: "POST",
					token: target.token,
					body: { texts, type, normalize: true, priority: "normal" },
				},
				embedTimeoutMs,
				signal,
			);
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
			const vectors = validateEmbeddings(
				await link.readJson(response),
				texts.length,
				type,
			);
			link.markHealthy();
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
		status: () => link.status(),
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
		release: () => link.release(),
	};
}
