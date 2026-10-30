import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { canonicalJson, sha256Hex } from "../../../../infrastructure/digest";
import { LarmError, type ChatResult } from "../../../larm";
import {
	DistillError,
	type DistillDeps,
	type DistillStage,
	type LlmOutcome,
} from "../../contracts";
import { findOkCallByDigest, insertLlmCall } from "../../repository";

export interface JsonCall<T> {
	runId: string | null;
	stage: DistillStage;
	subjectRef: string;
	promptVersion: string;
	system: string;
	user: string;
	schema: z.ZodType<T>;
	maxOutputTokens: number;
	signal: AbortSignal;
}

export interface JsonCallResult<T> {
	value: T;
	/** The distill_llm_calls row of the answer that was used. */
	callId: string;
	/** true: an earlier answer for the same input was reused and the model was not called. */
	cached: boolean;
}

/** The reuse key: the same provider, model, prompt version and texts give the same digest. */
export function inputDigest(
	provider: string,
	model: string | null,
	call: Pick<JsonCall<unknown>, "promptVersion" | "system" | "user">,
): string {
	return sha256Hex(
		canonicalJson({
			provider,
			model,
			promptVersion: call.promptVersion,
			system: call.system,
			user: call.user,
		}),
	);
}

type Parsed<T> =
	| { ok: true; value: T; json: unknown }
	| { ok: false; json: unknown | null; problem: string };

/** The model sometimes wraps its JSON in a code fence; nothing else is tolerated. */
function stripFence(text: string): string {
	const m = /^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/.exec(text);
	return (m ? m[1]! : text).trim();
}

function parseOutput<T>(text: string, schema: z.ZodType<T>): Parsed<T> {
	let json: unknown;
	try {
		json = JSON.parse(stripFence(text));
	} catch {
		return { ok: false, json: null, problem: "the output is not valid JSON" };
	}
	const parsed = schema.safeParse(json);
	if (parsed.success) return { ok: true, value: parsed.data, json };
	// Only the paths of the issues go back to the model, never the values it produced.
	const paths = [
		...new Set(
			parsed.error.issues.map((i) =>
				i.path.length ? i.path.join(".") : "(root)",
			),
		),
	].slice(0, 20);
	return {
		ok: false,
		json,
		problem: `the output does not match the schema at: ${paths.join(", ")}`,
	};
}

/**
 * One JSON answer from the model, validated by `schema`.
 *  - An `ok` answer stored for the same input digest and the same model is parsed again and
 *    returned (`cached`). The digest leaves the model out, because a LARM client knows its model
 *    only once connected; until then (`model()` null) nothing is reused, and the row records the
 *    model that answered.
 *  - Otherwise the model is called once. If its output is not JSON or fails the schema, it is
 *    asked once more, told only which paths were wrong. A second failure is recorded as
 *    `invalid_output` and ends in `DistillError("llm_invalid_output")`.
 *  - A `LarmError` is recorded as `provider_error` and rethrown as it is (the queue's classify
 *    decides retry or fail).
 * Every call is one row of distill_llm_calls; nothing of the prompt or the answer is logged.
 */
export async function callJson<T>(
	deps: DistillDeps,
	call: JsonCall<T>,
): Promise<JsonCallResult<T>> {
	const digest = inputDigest(deps.llm.provider, null, call);
	const model = deps.llm.model?.() ?? null;
	const stored =
		model === null
			? null
			: deps.store.read((db) => findOkCallByDigest(db, digest, model));
	if (stored) {
		const parsed = call.schema.safeParse(stored.response);
		if (parsed.success)
			return { value: parsed.data, callId: stored.id, cached: true };
	}

	const messages: { role: "system" | "user" | "assistant"; content: string }[] =
		[
			{ role: "system", content: call.system },
			{ role: "user", content: call.user },
		];
	for (let attempt = 0; attempt < 2; attempt++) {
		const started = deps.now().getTime();
		let result: ChatResult;
		try {
			result = await deps.llm.chat({
				messages,
				maxOutputTokens: call.maxOutputTokens,
				json: true,
				signal: call.signal,
			});
		} catch (error) {
			if (error instanceof LarmError)
				await record(deps, call, digest, started, "provider_error", null, null);
			throw error;
		}
		const parsed = parseOutput(result.text, call.schema);
		const id = await record(
			deps,
			call,
			digest,
			started,
			parsed.ok ? "ok" : "invalid_output",
			result,
			parsed.json,
		);
		if (parsed.ok) return { value: parsed.value, callId: id, cached: false };
		if (attempt === 1) break;
		messages.push(
			{ role: "assistant", content: result.text },
			{
				role: "user",
				content: `${parsed.problem}. Return the corrected JSON object only.`,
			},
		);
	}
	throw new DistillError("llm_invalid_output");
}

async function record<T>(
	deps: DistillDeps,
	call: JsonCall<T>,
	digest: string,
	startedMs: number,
	outcome: LlmOutcome,
	result: ChatResult | null,
	response: unknown | null,
): Promise<string> {
	const id = `lc_${randomUUID()}`;
	const at = deps.now();
	await deps.store.write((db) =>
		insertLlmCall(db, {
			id,
			runId: call.runId,
			stage: call.stage,
			subjectRef: call.subjectRef,
			provider: deps.llm.provider,
			model: result?.model ?? deps.llm.model?.() ?? "",
			promptVersion: call.promptVersion,
			inputDigest: digest,
			inputTokens: result?.usage.inputTokens ?? null,
			outputTokens: result?.usage.outputTokens ?? null,
			latencyMs: Math.max(0, at.getTime() - startedMs),
			outcome,
			response,
			at: at.toISOString(),
		}),
	);
	return id;
}
