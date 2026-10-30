import {
	type EmbeddingInputType,
	LarmError,
	type LarmErrorCode,
} from "../../larm";
import type { IndexingDeps } from "../contracts";

/** Busy retries per batch (the first attempt is not counted). */
export const MAX_BUSY_RETRIES = 5;
const DEFAULT_BUSY_WAIT_MS = 30_000;

/** Failed batches in a row after which `embedMissing` stops (earlier batches stay saved). */
export const MAX_CONSECUTIVE_FAILURES = 3;

/** Thrown when embedding stops after repeated batch failures; the message carries the reason. */
export class EmbedAbortedError extends Error {
	constructor(
		public reason: string,
		public embedded: number,
		public failed: number,
	) {
		super(`embed_aborted: ${reason}`);
		this.name = "EmbedAbortedError";
	}
}

/** Codes that mean the connection itself is wrong; waiting or skipping a batch cannot help. */
const STOP_CODES: ReadonlySet<LarmErrorCode> = new Set([
	"larm_provider_conflict",
	"larm_embedding_space_mismatch",
	"larm_not_configured",
	"larm_token_missing",
]);

export function isStopError(error: unknown): error is LarmError {
	return error instanceof LarmError && STOP_CODES.has(error.code);
}

export type EmbedOutcome =
	| { ok: true; vectors: Float32Array[]; busyWaits: number }
	| { ok: false; error: unknown; busyWaits: number };

/**
 * Embeds one batch. `larm_busy` sleeps `retryAfterMs` and repeats the same batch up to
 * MAX_BUSY_RETRIES times. A stop error is thrown; any other failure is returned so the caller
 * can count the batch as failed.
 */
export async function embedBatch(
	deps: Pick<IndexingDeps, "larm" | "sleep" | "log">,
	texts: string[],
	type: EmbeddingInputType,
): Promise<EmbedOutcome> {
	let busyWaits = 0;
	let reconnected = false;
	for (let attempt = 0; ; attempt++) {
		try {
			const vectors = await deps.larm.embed(texts, type);
			if (vectors.length !== texts.length)
				return {
					ok: false,
					error: new LarmError("larm_contract_mismatch"),
					busyWaits,
				};
			return { ok: true, vectors, busyWaits };
		} catch (error) {
			if (isStopError(error)) throw error;
			if (
				error instanceof LarmError &&
				error.code === "larm_busy" &&
				attempt < MAX_BUSY_RETRIES
			) {
				const wait = error.retryAfterMs ?? DEFAULT_BUSY_WAIT_MS;
				busyWaits++;
				deps.log(
					`larm_busy: waiting ${wait}ms (retry ${attempt + 1}/${MAX_BUSY_RETRIES})`,
				);
				await deps.sleep(wait);
				continue;
			}
			if (
				error instanceof LarmError &&
				error.code === "larm_deploying" &&
				!reconnected
			) {
				// The connection's lease (about 300 s) ran out during a long run; the client makes a
				// new connection on the next call, so the same batch is tried once more.
				reconnected = true;
				deps.log("larm_deploying: retrying the batch once on a new connection");
				continue;
			}
			return { ok: false, error, busyWaits };
		}
	}
}

export function errorCode(error: unknown): string {
	return error instanceof LarmError
		? error.code
		: error instanceof Error
			? error.message
			: "unknown";
}
