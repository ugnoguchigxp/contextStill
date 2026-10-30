import { canonicalJson, sha256Hex } from "../../../../infrastructure/digest";
import type {
	ChatRequest,
	ChatResult,
	LarmEmbeddingStatus,
	LlmClient,
} from "../../../larm";

/**
 * A fixed-answer `LlmClient` for tests (no network, no LARM).
 *
 *   const llm = createFakeLlm();
 *   llm.when(/a1\./, { schemaVersion: 1, items: [...] });      // text of the messages matches
 *   llm.when((req) => req.messages.length > 2, repairedJson);  // the repair round of callJson
 *   llm.onDigest(requestDigest(req), json);                    // exactly this request
 *   llm.queue(first, second);                                  // anything unmatched, in order
 *   llm.fallback = { ... };                                    // anything unmatched, always
 *
 * A reply is: an object (sent as its JSON), a string (sent as the raw text, e.g. broken JSON),
 * an `Error` (thrown, e.g. `new LarmError("larm_busy", 1000)`), or a function of the request
 * returning one of those. Several replies after a matcher are consumed in order; the last one
 * repeats. Rules are tried in the order they were added. `llm.calls` holds every request.
 */
export type FakeReply =
	| unknown
	| Error
	| ((req: ChatRequest) => unknown | Promise<unknown>);

export type FakeMatch = string | RegExp | ((req: ChatRequest) => boolean);

interface Rule {
	test: (req: ChatRequest) => boolean;
	replies: FakeReply[];
	used: number;
}

export interface FakeLlm extends LlmClient {
	readonly provider: "fixture";
	readonly calls: ChatRequest[];
	released: number;
	fallback: FakeReply | undefined;
	when(match: FakeMatch, ...replies: FakeReply[]): FakeLlm;
	onDigest(digest: string, ...replies: FakeReply[]): FakeLlm;
	queue(...replies: FakeReply[]): FakeLlm;
}

/** The digest of what the model is shown; stable across runs, usable with `onDigest`. */
export function requestDigest(req: Pick<ChatRequest, "messages">): string {
	return sha256Hex(canonicalJson(req.messages));
}

export const messageText = (req: Pick<ChatRequest, "messages">): string =>
	req.messages.map((m) => m.content).join("\n");

/** True for the second round of `callJson` (it appends the invalid answer and a correction). */
export const isRepair = (req: Pick<ChatRequest, "messages">): boolean =>
	req.messages.length > 2;

export function createFakeLlm(
	options: { model?: string | null; chatModel?: string } = {},
): FakeLlm {
	const rules: Rule[] = [];
	const sequence: Rule = { test: () => true, replies: [], used: 0 };
	const model = options.model === undefined ? "fake-llm-1" : options.model;
	const chatModel = options.chatModel ?? model ?? "fake-llm-1";

	const next = (rule: Rule): FakeReply => {
		const reply = rule.replies[Math.min(rule.used, rule.replies.length - 1)];
		rule.used++;
		return reply;
	};

	const llm: FakeLlm = {
		provider: "fixture",
		calls: [],
		released: 0,
		fallback: undefined,
		model: () => model,
		status(): LarmEmbeddingStatus {
			return {
				configured: true,
				tokenPresent: true,
				connection: "ready",
				lastError: null,
			};
		},
		async chat(req): Promise<ChatResult> {
			llm.calls.push(req);
			req.signal?.throwIfAborted();
			let reply: FakeReply;
			const rule = rules.find((r) => r.test(req));
			if (rule) reply = next(rule);
			else if (
				sequence.replies.length > 0 &&
				sequence.used < sequence.replies.length
			)
				reply = next(sequence);
			else if (llm.fallback !== undefined) reply = llm.fallback;
			else throw new Error("fake_llm_no_reply");
			if (typeof reply === "function") reply = await reply(req);
			if (reply instanceof Error) throw reply;
			const text = typeof reply === "string" ? reply : JSON.stringify(reply);
			return {
				text,
				model: chatModel,
				finishReason: "stop",
				usage: {
					inputTokens: Math.ceil(messageText(req).length / 4),
					outputTokens: Math.ceil(text.length / 4),
				},
			};
		},
		async release() {
			llm.released++;
		},
		when(match, ...replies) {
			const test =
				typeof match === "function"
					? match
					: match instanceof RegExp
						? (req: ChatRequest) => match.test(messageText(req))
						: (req: ChatRequest) => messageText(req).includes(match);
			rules.push({ test, replies, used: 0 });
			return llm;
		},
		onDigest(digest, ...replies) {
			rules.push({
				test: (req) => requestDigest(req) === digest,
				replies,
				used: 0,
			});
			return llm;
		},
		queue(...replies) {
			sequence.replies.push(...replies);
			return llm;
		},
	};
	return llm;
}
