import { z } from "zod";
import { sha256Hex } from "../../../../infrastructure/digest";
import { setEpisodeRetrieval } from "../../../experience";
import { LarmError } from "../../../larm";
import { setKnowledgeDisposition } from "../../../knowledge";
import { clustersOfMember } from "../../../map";
import type { HandlerDefinition, Tx } from "../../../queue";
import {
	assessMaxOutputTokens,
	buildAssessUser,
	ASSESS_PROMPT_VERSION,
	ASSESS_SYSTEM,
	clip,
	type AssessPromptItem,
} from "../../prompts/assess";
import {
	assessOutput,
	DistillError,
	type AssessModule,
	type DistillDeps,
	type DistillStage,
	type Generality,
	type OwnerKind,
	type StartStageOptions,
} from "../../contracts";
import {
	addRunCounts,
	finishRun,
	getAssessment,
	getRun,
	upsertAssessment,
} from "../../repository";
import { buildRepoTerms, type RepoSignals } from "../checks";
import { callJson } from "../llm";
import { enqueuePlaceInTransaction, SCOPE } from "../cluster/job";
import { reopenCluster } from "../cluster/place";
import {
	assessSignals,
	decideGenerality,
	isEvidenceOnly,
	legacyInfo,
} from "./decide";
import {
	episodeContentDigest,
	hasPendingPlacement,
	listTodo,
	type TodoItem,
} from "./todo";

export { ASSESS_PROMPT_VERSION } from "../../prompts/assess";
export { episodeContentDigest, listTodo, hasPendingPlacement } from "./todo";

export const ASSESS_KIND = "distill.assess";
/** Items per job (the model is given this many notes at once). */
export const ASSESS_BATCH = 20;

const payloadSchema = z.object({
	runId: z.string().min(1),
	owner: z.enum(["knowledge", "episode"]),
	ids: z.array(z.string().min(1)).min(1).max(ASSESS_BATCH),
});
type Payload = z.infer<typeof payloadSchema>;

interface Item {
	ref: string;
	id: string;
	digest: string;
	/** Stored in signals_json. */
	signals: Record<string, unknown>;
	found: RepoSignals;
	prompt: AssessPromptItem;
}
interface Input {
	runId: string;
	owner: OwnerKind;
	items: Item[];
	incremental: boolean;
}
interface Output {
	verdicts: Record<string, { generality: Generality; reason: string }>;
	callId: string | null;
	/** The model's answer could not be used (twice invalid). */
	invalid: boolean;
}

type Mode = "assess" | "incremental";
const ownersOf = (mode: Mode): OwnerKind[] =>
	mode === "incremental" ? ["knowledge"] : ["knowledge", "episode"];
const modeOf = (stage: DistillStage): Mode =>
	stage === "incremental" ? "incremental" : "assess";

interface Chunk {
	owner: OwnerKind;
	items: TodoItem[];
}

export interface AssessEngine extends AssessModule {
	/** The chunk plan of a stage: how many jobs it will take (for a dry run). */
	plan(stage: DistillStage, opts: StartStageOptions): number;
}

/**
 * The stage assess (6.1) and the assess part of the incremental stage (6.10).
 *
 * The work is a chain: `start` enqueues the first job of 20 items; the job that settles enqueues
 * the next one (the ids after its last id, then the next owner) and the last one closes the run
 * (stage assess) or enqueues the placement (stage incremental). So one stage never holds more
 * than a job or two of the queue's open-job limit, however many rows there are.
 */
export function createAssess(deps: DistillDeps): AssessEngine {
	const at = () => deps.now().toISOString();

	/** Repo names of every repo_key in the store (the terms of sign (a)). */
	function repoTerms(tx: Tx): string[] {
		const rows = tx
			.query(
				`SELECT repo_key AS k FROM knowledge_items WHERE repo_key IS NOT NULL
				 UNION SELECT repo_key AS k FROM episodes WHERE repo_key IS NOT NULL`,
			)
			.all() as { k: string }[];
		return buildRepoTerms(rows.map((r) => r.k));
	}

	function nextChunk(
		tx: Tx,
		mode: Mode,
		budget: { limit: number | undefined; processed: number },
		from: { owner: OwnerKind; after: string } | null,
	): Chunk | null {
		const remaining =
			budget.limit === undefined
				? Number.POSITIVE_INFINITY
				: budget.limit - budget.processed;
		if (remaining <= 0) return null;
		const size = Math.min(ASSESS_BATCH, remaining);
		const owners = ownersOf(mode);
		const first = from ? owners.indexOf(from.owner) : 0;
		for (let i = Math.max(0, first); i < owners.length; i++) {
			const owner = owners[i]!;
			const items = listTodo(tx, owner, {
				after: i === first && from ? from.after : null,
				limit: size,
				promptVersion: mode === "assess" ? ASSESS_PROMPT_VERSION : null,
			});
			if (items.length > 0) return { owner, items };
		}
		return null;
	}

	function enqueueChunk(tx: Tx, runId: string, chunk: Chunk): void {
		const ids = chunk.items.map((i) => i.id);
		const key = sha256Hex(
			JSON.stringify(chunk.items.map((i) => [i.id, i.digest])),
		);
		deps.queue.enqueueInTransaction(tx, {
			scope: SCOPE,
			kind: ASSESS_KIND,
			dedupeKey: `assess:${chunk.owner}:${key}:${ASSESS_PROMPT_VERSION}:${runId}`,
			payload: { runId, owner: chunk.owner, ids } satisfies Payload,
			subjectRef: `assess:${chunk.owner}:${ids[0]}`,
			lane: "background",
			resourceKey: "llm",
			maxAttempts: 3,
		});
	}

	function limitOf(params: Record<string, unknown>): number | undefined {
		return typeof params.limit === "number" ? params.limit : undefined;
	}

	// ---- the handler ------------------------------------------------------------------

	function prepare(tx: Tx, payload: Payload): Input | "stale" {
		const run = getRun(tx, payload.runId);
		if (!run || run.state !== "running") return "stale";
		const owner = payload.owner;
		const terms = repoTerms(tx);
		const marks = payload.ids.map(() => "?").join(", ");
		const items: Item[] = [];
		const rows =
			owner === "knowledge"
				? (tx
						.query(
							`SELECT id, title, body, situation, type, polarity, applies_when_json, scope,
							        repo_key, content_digest, metadata_json
							 FROM knowledge_items
							 WHERE id IN (${marks}) AND layer = 'atom' AND space <> 'personal'
							   AND status IN ('active', 'superseded') ORDER BY id`,
						)
						.all(...payload.ids) as Record<string, string | null>[])
				: (tx
						.query(
							`SELECT id, title, situation, action, outcome, lesson, scope, repo_key, metadata_json
							 FROM episodes
							 WHERE id IN (${marks}) AND status = 'active' AND scope = 'global'
							   AND space <> 'personal' ORDER BY id`,
						)
						.all(...payload.ids) as Record<string, string | null>[]);
		const prefix = owner === "knowledge" ? "a" : "e";
		for (const row of rows) {
			const s = (k: string) => row[k] ?? "";
			const fields: Record<string, string> =
				owner === "knowledge"
					? {
							...(s("situation") ? { situation: clip(s("situation")) } : {}),
							body: clip(s("body")),
						}
					: {
							situation: clip(s("situation")),
							action: clip(s("action")),
							outcome: clip(s("outcome")),
							lesson: clip(s("lesson")),
						};
			const text = [s("title"), ...Object.values(fields)].join("\n");
			const legacy = legacyInfo(s("metadata_json"));
			const { found, stored } = assessSignals(
				text,
				terms,
				{ scope: s("scope"), repoKey: row.repo_key ?? null },
				legacy,
			);
			const ref = `${prefix}${items.length + 1}`;
			items.push({
				ref,
				id: s("id"),
				digest:
					owner === "knowledge"
						? s("content_digest")
						: episodeContentDigest({
								title: s("title"),
								situation: s("situation"),
								action: s("action"),
								outcome: s("outcome"),
								lesson: s("lesson"),
							}),
				signals: stored,
				found,
				prompt: {
					ref,
					title: clip(s("title"), 300),
					text: fields,
					...(owner === "knowledge"
						? { type: s("type"), polarity: s("polarity") }
						: {}),
					hints: {
						legacyScope: legacy.scope ?? s("scope"),
						repoTerms: found.repoTerms,
						paths: found.absolutePaths.length + found.relativePaths.length,
						ports: found.ports.length,
					},
				},
			});
		}
		return {
			runId: payload.runId,
			owner,
			items,
			incremental: run.stage === "incremental",
		};
	}

	async function execute(
		input: Input,
		ctx: { signal: AbortSignal },
	): Promise<Output> {
		if (input.items.length === 0)
			return { verdicts: {}, callId: null, invalid: false };
		try {
			const { value, callId } = await callJson(deps, {
				runId: input.runId,
				stage: input.incremental ? "incremental" : "assess",
				subjectRef: `${input.owner}:${input.items[0]!.id}`,
				promptVersion: ASSESS_PROMPT_VERSION,
				system: ASSESS_SYSTEM,
				user: buildAssessUser(input.items.map((i) => i.prompt)),
				schema: assessOutput,
				maxOutputTokens: assessMaxOutputTokens(input.items.length),
				signal: ctx.signal,
			});
			const verdicts: Output["verdicts"] = {};
			for (const item of value.items)
				// The first answer for a ref counts; an unknown ref is ignored.
				if (!verdicts[item.ref])
					verdicts[item.ref] = {
						generality: item.generality,
						reason: item.reason,
					};
			return { verdicts, callId, invalid: false };
		} catch (error) {
			// An unusable answer is not a failure of the job: the rows stay unassessed.
			if (error instanceof DistillError && error.code === "llm_invalid_output")
				return { verdicts: {}, callId: null, invalid: true };
			throw error;
		}
	}

	function settle(
		tx: Tx,
		payload: Payload,
		input: Input | null,
		outcome: Parameters<
			HandlerDefinition<Payload, Input, Output>["settleInTransaction"]
		>[3],
	) {
		if (outcome.type === "retry") return "applied" as const;
		if (outcome.type !== "success" || !input) {
			finishRun(tx, payload.runId, "failed", at());
			return "applied" as const;
		}
		const run = getRun(tx, payload.runId);
		if (!run || run.state !== "running") return "stale" as const;
		const out = outcome.result;
		const counts: Record<string, number> = {
			processed: payload.ids.length,
			invalid: out.invalid ? input.items.length : 0,
		};
		const bump = (key: string) => (counts[key] = (counts[key] ?? 0) + 1);
		for (const item of input.items) {
			const verdict = out.verdicts[item.ref];
			if (!verdict) {
				if (!out.invalid) bump("missing");
				continue;
			}
			if (currentDigest(tx, input.owner, item.id) !== item.digest) {
				bump("changed");
				continue;
			}
			const before = getAssessment(tx, input.owner, item.id);
			if (before?.origin === "human" && before.contentDigest === item.digest)
				continue;
			const decided = decideGenerality(verdict.generality, item.found);
			// A superseded atom is judged again only so the canonical it was absorbed into is
			// distilled again from its new text: its retrieval and placement are not touched.
			const superseded =
				input.owner === "knowledge" && isSuperseded(tx, item.id);
			const evidenceOnly = !superseded && isEvidenceOnly(decided.generality);
			upsertAssessment(tx, {
				ownerKind: input.owner,
				ownerId: item.id,
				generality: decided.generality,
				signals: {
					...item.signals,
					...(decided.downgraded ? { downgraded: true } : {}),
					...(input.incremental &&
					input.owner === "knowledge" &&
					!superseded &&
					!evidenceOnly
						? { placement: "pending" }
						: {}),
				},
				reason: verdict.reason,
				origin: "llm",
				contentDigest: item.digest,
				promptVersion: ASSESS_PROMPT_VERSION,
				callId: out.callId,
				at: at(),
			});
			bump(decided.generality);
			if (decided.downgraded) bump("downgraded");
			// evidence_only is the only retrieval this stage sets; it gives it back only to a row
			// it had taken out itself.
			if (superseded) {
				for (const cid of clustersOfMember(tx, "knowledge", item.id, "claim"))
					if (reopenCluster(tx, cid, at())) bump("reopened");
				continue;
			}
			const wasEvidenceOnly = before
				? isEvidenceOnly(before.generality)
				: false;
			if (evidenceOnly || wasEvidenceOnly)
				setRetrieval(
					tx,
					input.owner,
					item.id,
					evidenceOnly ? "evidence_only" : "searchable",
				);
			if (evidenceOnly) bump("evidenceOnly");
		}
		addRunCounts(tx, payload.runId, counts);

		const mode = modeOf(run.stage);
		const processed = (getRun(tx, payload.runId)?.counts.processed ??
			0) as number;
		const last = payload.ids[payload.ids.length - 1]!;
		const next = nextChunk(
			tx,
			mode,
			{ limit: limitOf(run.params), processed },
			{ owner: payload.owner, after: last },
		);
		if (next) enqueueChunk(tx, payload.runId, next);
		else if (mode === "incremental" && hasPendingPlacement(tx))
			enqueuePlaceInTransaction(deps, tx, payload.runId);
		else finishRun(tx, payload.runId, "completed", at());
		return "applied" as const;
	}

	function isSuperseded(tx: Tx, id: string): boolean {
		return (
			tx
				.query(
					"SELECT 1 FROM knowledge_items WHERE id = ? AND layer = 'atom' AND status = 'superseded'",
				)
				.get(id) !== null
		);
	}

	function currentDigest(tx: Tx, owner: OwnerKind, id: string): string | null {
		if (owner === "knowledge")
			return (
				(
					tx
						.query(
							"SELECT content_digest AS d FROM knowledge_items WHERE id = ? AND layer = 'atom' AND space <> 'personal' AND status IN ('active', 'superseded')",
						)
						.get(id) as { d: string } | null
				)?.d ?? null
			);
		const row = tx
			.query(
				"SELECT title, situation, action, outcome, lesson FROM episodes WHERE id = ? AND status = 'active' AND scope = 'global' AND space <> 'personal'",
			)
			.get(id) as Parameters<typeof episodeContentDigest>[0] | null;
		return row ? episodeContentDigest(row) : null;
	}

	function setRetrieval(
		tx: Tx,
		owner: OwnerKind,
		id: string,
		retrieval: "searchable" | "evidence_only",
	): void {
		if (owner === "knowledge")
			setKnowledgeDisposition(tx, id, { retrieval, updatedAt: at() });
		else setEpisodeRetrieval(tx, id, retrieval, at());
	}

	const handler: HandlerDefinition<Payload, Input, Output> = {
		kind: ASSESS_KIND,
		payloadVersions: [1],
		schema: payloadSchema,
		recovery: "replay_safe",
		resourceKey: "llm",
		prepareInTransaction(tx, claim) {
			const input = prepare(tx, claim.payload);
			return input === "stale"
				? { status: "stale", reason: "run_not_running" }
				: { status: "ready", input };
		},
		execute,
		classify(error) {
			if (
				error instanceof LarmError &&
				(error.code === "larm_busy" ||
					error.code === "larm_unreachable" ||
					error.code === "larm_deploying")
			)
				return "retry";
			return "fail";
		},
		settleInTransaction(tx, claim, input, outcome) {
			return settle(tx, claim.payload, input, outcome);
		},
		afterCommit: () => deps.queue.wake(),
		cancelInTransaction(tx, job) {
			finishRun(tx, job.payload.runId, "cancelled", at());
		},
	};

	function plan(stage: DistillStage, opts: StartStageOptions): number {
		const mode = modeOf(stage);
		return deps.store.read((db) => {
			let budget = opts.limit ?? Number.POSITIVE_INFINITY;
			let jobs = 0;
			for (const owner of ownersOf(mode)) {
				const n = listTodo(db, owner, {
					after: null,
					limit: Number.isFinite(budget) ? budget : -1,
					promptVersion: mode === "assess" ? ASSESS_PROMPT_VERSION : null,
				}).length;
				jobs += Math.ceil(n / ASSESS_BATCH);
				budget -= n;
			}
			return jobs;
		});
	}

	return {
		registerHandlers() {
			deps.queue.registerHandler(handler);
		},
		plan,
		async start(stage, runId, opts) {
			const mode = modeOf(stage);
			if (opts.dryRun) {
				const jobs = plan(stage, opts);
				const placing =
					mode === "incremental" &&
					deps.store.read((db) => hasPendingPlacement(db));
				return jobs + (placing && jobs === 0 ? 1 : 0);
			}
			const first = deps.store.read((db) =>
				nextChunk(db, mode, { limit: opts.limit, processed: 0 }, null),
			);
			if (first) {
				await deps.store.write((tx) => enqueueChunk(tx, runId, first));
				deps.queue.wake();
				return 1;
			}
			if (mode === "incremental") {
				const pending = deps.store.read((db) => hasPendingPlacement(db));
				if (pending) {
					await deps.store.write((tx) =>
						enqueuePlaceInTransaction(deps, tx, runId),
					);
					deps.queue.wake();
					return 1;
				}
			}
			return 0;
		},
	};
}
