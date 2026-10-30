import type { Database } from "bun:sqlite";
import { z } from "zod";
import { sha256Hex } from "../../../../infrastructure/digest";
import { getEpisodeById } from "../../../experience";
import {
	getKnowledgeById,
	listKnowledgeEvidence,
	upsertKnowledgeItem,
	type CanonicalExample,
	type KnowledgeRow,
} from "../../../knowledge";
import { edgesTo, setEdgeStatus, upsertEdge } from "../../../map";
import type { HandlerDefinition } from "../../../queue";
import { getVector } from "../../../vectors";
import {
	DistillError,
	examplesOutput,
	type DistillDeps,
	type DistillStage,
	type ExamplesModule,
	type ExamplesOutput,
	type StartStageOptions,
} from "../../contracts";
import {
	EXAMPLES_PROMPT_VERSION,
	EXAMPLES_SYSTEM,
	examplesRepairUser,
	examplesUser,
} from "../../prompts/examples";
import {
	addRunCounts,
	finishRun,
	getThresholds,
	insertReview,
} from "../../repository";
import { buildRepoTerms, repoSignals } from "../checks";
import { callJson } from "../llm";
import {
	episodesOfSources,
	isExampleEpisode,
	listActiveCanonicals,
	listActiveEpisodeIds,
	listRepoKeys,
} from "../theme/queries";
import {
	classifyError,
	clearWorkTail,
	enqueueWindow,
	reviewId,
	runIsOpen,
	saveWorkTail,
	settleRunJob,
	type WorkItem,
} from "../theme/work";
import {
	pickCandidates,
	type EpisodeCandidate,
	type EpisodeMatrix,
} from "./candidates";

const KIND = "distill.examples";
const EXTRACTOR_VERSION = "examples.v1";
/** Canonicals per job. */
const CHUNK = 4;

const payloadSchema = z.strictObject({
	runId: z.string().min(1),
	seq: z.number().int().min(0),
	canonicalIds: z.array(z.string().min(1)).min(1).max(CHUNK),
});
type Payload = z.infer<typeof payloadSchema>;

interface Entry {
	id: string;
	contentDigest: string;
	title: string;
	situation: string;
	body: string;
	vector: Float32Array | null;
	sameSource: string[];
}
interface Input {
	runId: string;
	entries: Entry[];
	repoTerms: string[];
	threshold: number;
}

type Result =
	| {
			canonicalId: string;
			contentDigest: string;
			status: "ok";
			examples: CanonicalExample[];
			candidates: EpisodeCandidate[];
	  }
	| {
			canonicalId: string;
			contentDigest: string;
			status: "rejected" | "invalid";
			findings: string[];
	  };
interface Output {
	results: Result[];
}

/**
 * Host check of the generalised examples (6.9): the cited aliases are candidates of this
 * canonical, and the texts carry no repo name, path or port.
 */
export function checkExamples(
	output: ExamplesOutput,
	aliases: ReadonlySet<string>,
	repoTerms: readonly string[],
): string[] {
	const findings: string[] = [];
	output.examples.forEach((example, i) => {
		const seen = new Set<string>();
		for (const alias of example.episodes) {
			if (!aliases.has(alias))
				findings.push(`examples[${i}].episodes: ${alias} is not a candidate`);
			else if (seen.has(alias))
				findings.push(`examples[${i}].episodes: ${alias} is listed twice`);
			seen.add(alias);
		}
		for (const field of ["situation", "action", "outcome"] as const) {
			const text = example[field];
			if (text.trim().length === 0)
				findings.push(`examples[${i}].${field}: empty`);
			const s = repoSignals(text, repoTerms);
			for (const m of s.repoTerms)
				findings.push(`examples[${i}].${field}: repo_term ${m}`);
			for (const m of s.absolutePaths)
				findings.push(`examples[${i}].${field}: absolute_path ${m}`);
			for (const m of s.relativePaths)
				findings.push(`examples[${i}].${field}: relative_path ${m}`);
			for (const m of s.ports)
				findings.push(`examples[${i}].${field}: port ${m}`);
		}
	});
	return findings;
}

const sameExamples = (
	a: readonly CanonicalExample[],
	b: readonly CanonicalExample[],
) => JSON.stringify(a) === JSON.stringify(b);

const usableVector = (
	v: { origin: string; verification: string } | null,
	allowUnverified = false,
) =>
	v !== null &&
	(allowUnverified || v.origin === "larm" || v.verification === "verified");

function withExamples(
	row: KnowledgeRow,
	examples: CanonicalExample[],
	at: string,
) {
	return {
		id: row.id,
		layer: row.layer,
		type: row.type,
		polarity: row.polarity,
		title: row.title,
		body: row.body,
		situation: row.situation,
		rationale: row.rationale,
		exceptions: row.exceptions,
		examples,
		appliesWhen: row.appliesWhen,
		notAppliesWhen: row.notAppliesWhen,
		steps: row.steps,
		facets: row.facets,
		confidence: row.confidence,
		importance: row.importance,
		status: row.status,
		space: row.space,
		scope: row.scope,
		repoKey: row.repoKey,
		validFrom: row.validFrom,
		validUntil: row.validUntil,
		provenanceStatus: row.provenanceStatus,
		metadata: row.metadata,
		createdAt: row.createdAt,
		updatedAt: at,
	};
}

export function createExamples(deps: DistillDeps): ExamplesModule {
	let matrixCache: (EpisodeMatrix & { spaceKey: string }) | null = null;

	/** The vectors of the active episodes that may be compared (loaded once per run). */
	function episodeMatrix(): EpisodeMatrix {
		if (matrixCache && matrixCache.spaceKey === deps.spaceKey)
			return matrixCache;
		const ids: string[] = [];
		const vectors: Float32Array[] = [];
		deps.store.read((db) => {
			for (const id of listActiveEpisodeIds(db)) {
				const v = getVector(db, "episode", id, deps.spaceKey);
				if (v && usableVector(v)) {
					ids.push(id);
					vectors.push(v.vector);
				}
			}
		});
		matrixCache = { spaceKey: deps.spaceKey, ids, vectors };
		return matrixCache;
	}

	async function generalize(
		runId: string,
		entry: Entry,
		input: Input,
		signal: AbortSignal,
	): Promise<Result> {
		const base = { canonicalId: entry.id, contentDigest: entry.contentDigest };
		const candidates = pickCandidates({
			sameSource: entry.sameSource,
			vector: entry.vector,
			matrix: episodeMatrix(),
			threshold: input.threshold,
		});
		const rows = deps.store.read((db) =>
			candidates.map((c) => getEpisodeById(db, c.id)),
		);
		const present = candidates
			.map((c, i) => ({ candidate: c, row: rows[i] ?? null }))
			.filter((x) => x.row !== null && isExampleEpisode(x.row));
		if (present.length === 0)
			return { ...base, status: "ok", examples: [], candidates: [] };
		const aliasOf = new Map(present.map((x, i) => [`e${i + 1}`, x.candidate]));
		const aliases = new Set(aliasOf.keys());
		const user = examplesUser({
			title: entry.title,
			situation: entry.situation,
			guidance: entry.body,
			episodes: present.map((x, i) => ({
				alias: `e${i + 1}`,
				title: x.row!.title,
				situation: x.row!.situation,
				action: x.row!.action,
				outcome: x.row!.outcome,
				lesson: x.row!.lesson,
			})),
		});
		const ask = (text: string) =>
			callJson(deps, {
				runId,
				stage: "examples",
				subjectRef: `canonical:${entry.id}`,
				promptVersion: EXAMPLES_PROMPT_VERSION,
				system: EXAMPLES_SYSTEM,
				user: text,
				schema: examplesOutput,
				maxOutputTokens: 1500,
				signal,
			});
		try {
			let answer = await ask(user);
			let findings = checkExamples(answer.value, aliases, input.repoTerms);
			if (findings.length > 0) {
				answer = await ask(examplesRepairUser(user, findings));
				findings = checkExamples(answer.value, aliases, input.repoTerms);
			}
			if (findings.length > 0) return { ...base, status: "rejected", findings };
			const cited = new Map<string, EpisodeCandidate>();
			const examples: CanonicalExample[] = answer.value.examples.map((e) => {
				const episodeIds = e.episodes.map((alias) => {
					const c = aliasOf.get(alias)!;
					cited.set(c.id, c);
					return c.id;
				});
				return {
					situation: e.situation.trim(),
					action: e.action.trim(),
					outcome: e.outcome.trim(),
					episodeIds,
				};
			});
			return {
				...base,
				status: "ok",
				examples,
				candidates: [...cited.values()],
			};
		} catch (error) {
			if (error instanceof DistillError && error.code === "llm_invalid_output")
				return { ...base, status: "invalid", findings: [] };
			throw error;
		}
	}

	function settleResult(tx: Database, runId: string, r: Result, at: string) {
		const row = getKnowledgeById(tx, r.canonicalId);
		if (
			!row ||
			row.layer !== "canonical" ||
			row.status !== "active" ||
			row.contentDigest !== r.contentDigest
		)
			return "stale";
		if (r.status !== "ok") {
			insertReview(tx, {
				id: reviewId("host_rejected", "examples", row.id, row.contentDigest),
				kind: "host_rejected",
				subject: {
					stage: "examples",
					canonicalId: row.id,
					reason: r.status === "rejected" ? "host_check" : "llm_invalid_output",
					findings: r.findings,
				},
				at,
			});
			return "review";
		}
		if (!sameExamples(row.examples, r.examples))
			upsertKnowledgeItem(tx, withExamples(row, r.examples, at));
		const wanted = new Set(r.candidates.map((c) => c.id));
		for (const c of r.candidates)
			upsertEdge(tx, {
				src: { kind: "episode", id: c.id },
				relation: "example_of",
				dst: { kind: "knowledge", id: row.id },
				origin: c.via === "source" ? "deterministic" : "clustering",
				status: "candidate",
				confidence: Math.min(1, Math.max(0, c.similarity ?? 0.8)),
				evidence: { via: c.via, similarity: c.similarity, runId },
				extractorVersion: EXTRACTOR_VERSION,
				at,
			});
		for (const edge of edgesTo(tx, "knowledge", row.id, "example_of"))
			if (
				edge.src.kind === "episode" &&
				!wanted.has(edge.src.id) &&
				edge.origin !== "human" &&
				edge.status === "candidate"
			)
				setEdgeStatus(tx, edge.id, "retracted", at);
		return "ok";
	}

	const handler: HandlerDefinition<Payload, Input, Output> = {
		kind: KIND,
		payloadVersions: [1],
		schema: payloadSchema,
		recovery: "replay_safe",
		resourceKey: "llm",
		classify: classifyError,
		prepareInTransaction(tx, claim) {
			const p = claim.payload;
			if (!runIsOpen(tx, p.runId))
				return { status: "stale", reason: "run_closed" };
			const entries: Entry[] = [];
			for (const id of p.canonicalIds) {
				const row = getKnowledgeById(tx, id);
				if (!row || row.layer !== "canonical" || row.status !== "active")
					continue;
				const stored = getVector(tx, "knowledge", id, deps.spaceKey);
				const vector =
					stored &&
					stored.contentDigest === row.contentDigest &&
					usableVector(stored)
						? stored.vector
						: null;
				const sources: string[] = [];
				const direct: string[] = [];
				for (const e of listKnowledgeEvidence(tx, id)) {
					if (e.targetKind !== "atom" || e.targetId === null) continue;
					for (const a of listKnowledgeEvidence(tx, e.targetId)) {
						if (a.targetId === null) continue;
						if (a.targetKind === "source") sources.push(a.targetId);
						else if (a.targetKind === "episode") direct.push(a.targetId);
					}
				}
				const sameSource = new Set(episodesOfSources(tx, sources));
				for (const e of direct) {
					const episode = getEpisodeById(tx, e);
					if (episode && isExampleEpisode(episode)) sameSource.add(e);
				}
				entries.push({
					id,
					contentDigest: row.contentDigest,
					title: row.title,
					situation: row.situation,
					body: row.body,
					vector,
					sameSource: [...sameSource].sort(),
				});
			}
			return {
				status: "ready",
				input: {
					runId: p.runId,
					entries,
					repoTerms: buildRepoTerms(listRepoKeys(tx)),
					threshold: getThresholds(tx).pairCandidate,
				},
			};
		},
		async execute(input, context) {
			const results: Result[] = [];
			for (const entry of input.entries)
				results.push(
					await generalize(input.runId, entry, input, context.signal),
				);
			return { results };
		},
		settleInTransaction(tx, claim, _input, outcome) {
			if (outcome.type === "retry") return "applied";
			const p = claim.payload;
			const counts: Record<string, number> = {};
			if (outcome.type === "success") {
				const at = deps.now().toISOString();
				for (const r of outcome.result.results) {
					const key = settleResult(tx, p.runId, r, at);
					counts[key] = (counts[key] ?? 0) + 1;
				}
			}
			settleRunJob(tx, deps, {
				stage: "examples",
				runId: p.runId,
				seq: p.seq,
				fatal: outcome.type !== "success",
				counts,
			});
			return "applied";
		},
		cancelInTransaction(tx, job) {
			addRunCounts(tx, job.payload.runId, { cancelled: 1 });
			const at = deps.now().toISOString();
			clearWorkTail(tx, "examples", job.payload.runId, at);
			finishRun(tx, job.payload.runId, "cancelled", at);
		},
	};

	return {
		registerHandlers() {
			deps.queue.registerHandler(handler);
		},
		async start(
			stage: DistillStage,
			runId: string,
			opts: StartStageOptions,
		): Promise<number> {
			if (stage !== "examples")
				throw new DistillError("invalid_distill_request");
			matrixCache = null;
			const canonicals = deps.store.read((db) => listActiveCanonicals(db));
			if (canonicals.length === 0) return 0;
			// Without episode vectors there is nothing to compare: stop (6.9).
			const hasVector = deps.store.read((db) => {
				for (const id of listActiveEpisodeIds(db)) {
					const v = getVector(db, "episode", id, deps.spaceKey);
					if (v && usableVector(v, opts.allowUnverified)) return true;
				}
				return false;
			});
			if (!hasVector) throw new DistillError("distill_vectors_unverified");

			const items: WorkItem[] = [];
			for (let i = 0; i < canonicals.length; i += CHUNK) {
				const chunk = canonicals.slice(i, i + CHUNK);
				items.push({
					kind: KIND,
					dedupeKey: `examples:${runId}:${sha256Hex(chunk.map((c) => `${c.id}:${c.contentDigest}`).join("\n"))}:${EXAMPLES_PROMPT_VERSION}`,
					subjectRef: `canonical:${chunk[0]!.id}`,
					payload: {
						runId,
						seq: items.length,
						canonicalIds: chunk.map((c) => c.id),
					},
				});
			}
			const planned =
				opts.limit === undefined ? items : items.slice(0, opts.limit);
			if (opts.dryRun) return planned.length;
			const at = deps.now().toISOString();
			await deps.store.write((db) => {
				saveWorkTail(db, "examples", runId, planned, at);
				addRunCounts(db, runId, {
					planned: planned.length,
					canonicals: canonicals.length,
				});
			});
			await enqueueWindow(deps, planned);
			return planned.length;
		},
	};
}
