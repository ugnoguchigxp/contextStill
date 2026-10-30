import type { Database } from "bun:sqlite";
import { canonicalJson, sha256Hex } from "../../../../infrastructure/digest";
import { getKnowledgeById, type KnowledgeRow } from "../../../knowledge";
import { LarmError } from "../../../larm";
import {
	listClusterMembers,
	memberDigest,
	memberKey,
	getCluster,
	setClusterState,
	type ClusterRow,
} from "../../../map";
import type { HandlerDefinition } from "../../../queue";
import {
	DistillError,
	type CanonicalModule,
	type DistillDeps,
	type DistillStage,
	type StartStageOptions,
} from "../../contracts";
export { acceptReviewedDraft } from "./accept";
import { buildRepoTerms } from "../checks";
import { MERGE_ALGORITHM } from "../conflict/apply";
import {
	addRunCounts,
	finishRun,
	getAssessment,
	getRun,
	getThresholds,
	insertReview,
} from "../../repository";
import {
	collectWork,
	enqueueWork,
	FEED_WINDOW,
	jobEnded,
	readCursor,
} from "./feed";
import { distillUnit } from "./pipeline";
import { CANONICAL_PROMPT_VERSION } from "../../prompts/canonical-plan";
import {
	allRepoKeys,
	atomUsable,
	isUnverifiedAlgorithm,
	reviewId,
	usageTotals,
} from "./reads";
import { settleUnit } from "./settle";
import {
	canonicalPayload,
	embedPayload,
	type AtomView,
	type CanonicalPayload,
	type EmbedPayload,
	type UnitInput,
	type UnitResult,
} from "./types";

const RETRY_CODES: ReadonlySet<string> = new Set([
	"larm_busy",
	"larm_unreachable",
	"larm_deploying",
]);

/** Provider trouble that passes is retried; everything else fails the job (5.7). */
function classify(error: unknown): "retry" | "fail" {
	return error instanceof LarmError && RETRY_CODES.has(error.code)
		? "retry"
		: "fail";
}

const REPO_TERMS_TTL_MS = 60_000;

const SINGLE_SCOPE = { merge: false, clusterId: null } as const;

/** Stages canonical and embed (6.4). Building the module does no work. */
export function createCanonical(deps: DistillDeps): CanonicalModule {
	let repoTermsCache: { at: number; terms: string[] } | null = null;
	const repoTerms = (db: Database): string[] => {
		const now = deps.now().getTime();
		if (!repoTermsCache || now - repoTermsCache.at > REPO_TERMS_TTL_MS)
			repoTermsCache = { at: now, terms: buildRepoTerms(allRepoKeys(db)) };
		return repoTermsCache.terms;
	};

	function viewAtoms(db: Database, rows: KnowledgeRow[]): AtomView[] {
		const sorted = [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));
		const usage = usageTotals(
			db,
			sorted.map((r) => r.id),
		);
		return sorted.map((row, i) => ({
			alias: `a${i + 1}`,
			row,
			generality: getAssessment(db, "knowledge", row.id)?.generality ?? null,
			used: usage.get(row.id)?.used ?? 0,
			notUsed: usage.get(row.id)?.notUsed ?? 0,
		}));
	}

	/**
	 * A pending cluster that can no longer be distilled does not stay pending (it would be planned
	 * again by every run): it becomes `stale` (its members changed; the cluster stage rebuilds it)
	 * or, when it is too large for one job, goes to the owner. Returns what was recorded.
	 */
	function retireCluster(
		db: Database,
		cluster: ClusterRow,
		rows: readonly (KnowledgeRow | null)[],
		reason: string,
	): string {
		const at = deps.now().toISOString();
		if (reason === "too_many_members") {
			const atoms = rows.filter((r): r is KnowledgeRow => r !== null);
			const created = insertReview(db, {
				id: reviewId(
					"host_rejected",
					atoms.map((a) => ({ id: a.id, contentDigest: a.contentDigest })),
				),
				kind: "host_rejected",
				subject: {
					clusterId: cluster.id,
					atomIds: atoms.map((a) => a.id),
					handles: atoms.map((a) => a.handle),
					reason,
				},
				proposal: {
					promptVersion: CANONICAL_PROMPT_VERSION,
					reason,
					draft: null,
					violations: [],
				},
				at,
			});
			setClusterState(db, cluster.id, "review", at);
			deps.log(
				`distill.canonical cluster=${cluster.id} -> review (${reason}${created ? "" : ", review exists"})`,
			);
			return created ? "reviewOpened" : "reviewExists";
		}
		setClusterState(db, cluster.id, "stale", at);
		deps.log(`distill.canonical cluster=${cluster.id} -> stale (${reason})`);
		return "staleCluster";
	}

	/** The input of a job, or null when what it was made for has changed. */
	function buildInput(
		db: Database,
		payload: CanonicalPayload,
	): { input: UnitInput | null; note?: string } {
		if ("clusterId" in payload) {
			const cluster = getCluster(db, payload.clusterId);
			if (
				!cluster ||
				cluster.kind !== "claim" ||
				cluster.state !== "pending" ||
				cluster.memberDigest !== payload.memberDigest ||
				// Made under allowUnverified: refused, and left as it is (6.0).
				isUnverifiedAlgorithm(cluster.algorithm)
			)
				return { input: null };
			const members = listClusterMembers(db, cluster.id);
			const rows = members
				.filter((m) => m.kind === "knowledge")
				.map((m) => getKnowledgeById(db, m.id));
			const merge = cluster.algorithm === MERGE_ALGORITHM;
			const scope = { merge, clusterId: cluster.id };
			if (rows.length > 99)
				return {
					input: null,
					note: retireCluster(db, cluster, rows, "too_many_members"),
				};
			if (rows.length === 0 || !rows.every((r) => atomUsable(db, r, scope)))
				return {
					input: null,
					note: retireCluster(db, cluster, rows, "members_changed"),
				};
			const atoms = rows as KnowledgeRow[];
			if (members.length === atoms.length) {
				const digests = new Map(
					atoms.map((r) => [memberKey("knowledge", r.id), r.contentDigest]),
				);
				if (memberDigest(members, digests) !== cluster.memberDigest)
					return {
						input: null,
						note: retireCluster(db, cluster, rows, "members_changed"),
					};
			}
			return {
				input: {
					runId: payload.runId,
					kind: "cluster",
					clusterId: cluster.id,
					memberDigest: cluster.memberDigest,
					merge,
					atoms: viewAtoms(db, atoms),
					repoTerms: repoTerms(db),
				},
			};
		}
		const atoms = payload.singles
			.map((id) => getKnowledgeById(db, id))
			.filter((r): r is KnowledgeRow => atomUsable(db, r, SINGLE_SCOPE));
		if (atoms.length === 0) return { input: null };
		return {
			input: {
				runId: payload.runId,
				kind: "singles",
				clusterId: null,
				memberDigest: sha256Hex(
					canonicalJson(atoms.map((r) => [r.id, r.contentDigest])),
				),
				merge: false,
				atoms: viewAtoms(db, atoms),
				repoTerms: repoTerms(db),
			},
		};
	}

	const canonicalHandler: HandlerDefinition<
		CanonicalPayload,
		UnitInput,
		UnitResult
	> = {
		kind: "distill.canonical",
		payloadVersions: [1],
		schema: canonicalPayload,
		recovery: "replay_safe",
		resourceKey: "llm",
		prepareInTransaction(tx, claim) {
			const { input, note } = buildInput(tx, claim.payload);
			if (!input) {
				// The queue ends the job without settling it; the run still has to count it.
				jobEnded(tx, deps, claim.payload.runId, {
					stale: 1,
					...(note ? { [note]: 1 } : {}),
				});
				return { status: "stale", reason: "input_changed" };
			}
			return { status: "ready", input };
		},
		execute: (input, ctx) => distillUnit(deps, input, ctx.signal),
		classify,
		settleInTransaction(tx, claim, input, outcome) {
			const runId = claim.payload.runId;
			if (outcome.type === "retry") return "applied";
			if (outcome.type !== "success" || !input) {
				jobEnded(tx, deps, runId, { failed: 1 });
				return "applied";
			}
			const settled = settleUnit(
				tx,
				deps,
				claim.payload,
				input,
				outcome.result,
			);
			jobEnded(tx, deps, runId, settled.counts);
			return settled.status === "stale" ? "stale" : "applied";
		},
		afterCommit: () => deps.queue.wake(),
		cancelInTransaction(tx, job) {
			jobEnded(tx, deps, job.payload.runId, { cancelled: 1 });
		},
	};

	const embedHandler: HandlerDefinition<
		EmbedPayload,
		EmbedPayload,
		{ embedded: number; failed: number }
	> = {
		kind: "distill.embed",
		payloadVersions: [1],
		schema: embedPayload,
		recovery: "replay_safe",
		resourceKey: "embedding",
		prepareInTransaction: (_tx, claim) => ({
			status: "ready",
			input: claim.payload,
		}),
		async execute() {
			const report = await deps.embedKnowledge();
			deps.log(
				`distill.embed candidates=${report.candidates} embedded=${report.embedded} failed=${report.failed}`,
			);
			return { embedded: report.embedded, failed: report.failed };
		},
		classify,
		settleInTransaction(tx, claim, _input, outcome) {
			const runId = claim.payload.runId;
			if (outcome.type === "retry") return "applied";
			const at = deps.now().toISOString();
			if (outcome.type === "success") {
				addRunCounts(tx, runId, {
					embedded: outcome.result.embedded,
					...(outcome.result.failed > 0
						? { embedFailed: outcome.result.failed }
						: {}),
				});
				const failedJobs = getRun(tx, runId)?.counts.failed ?? 0;
				finishRun(
					tx,
					runId,
					failedJobs > 0 || outcome.result.failed > 0 ? "failed" : "completed",
					at,
				);
			} else {
				addRunCounts(tx, runId, { embedFailed: 1 });
				finishRun(tx, runId, "failed", at);
			}
			return "applied";
		},
		cancelInTransaction(tx, job) {
			finishRun(tx, job.payload.runId, "cancelled", deps.now().toISOString());
		},
	};

	return {
		registerHandlers() {
			deps.queue.registerHandler(canonicalHandler);
			deps.queue.registerHandler(embedHandler);
		},

		async start(
			stage: DistillStage,
			runId: string,
			opts: StartStageOptions,
		): Promise<number> {
			if (stage === "embed") {
				if (opts.dryRun) return 1;
				await deps.store.write((db) => {
					deps.queue.enqueueInTransaction(db, {
						scope: "distill",
						kind: "distill.embed",
						dedupeKey: `embed:${runId}`,
						payload: { runId },
						subjectRef: `run:${runId}`,
						lane: "background",
						maxAttempts: 3,
					});
				});
				deps.queue.wake();
				return 1;
			}
			if (stage !== "canonical")
				throw new DistillError("invalid_distill_request");

			const budget = opts.limit ?? Number.POSITIVE_INFINITY;
			const planned = deps.store.read((db) => {
				if (getThresholds(db).calibratedAt === null)
					throw new DistillError("distill_calibration_missing");
				return collectWork(
					db,
					runId,
					readCursor(db, runId),
					Number.POSITIVE_INFINITY,
					budget,
				).length;
			});
			if (opts.dryRun || planned === 0) return planned;
			const fed = await deps.store.write((db) => {
				// Read again in the writing transaction so the first window matches what is stored.
				const items = collectWork(
					db,
					runId,
					readCursor(db, runId),
					FEED_WINDOW,
					budget,
				);
				return enqueueWork(db, deps, runId, items);
			});
			// What changed between the two reads: with no job queued the run has nothing to wait for.
			if (fed === 0) return 0;
			deps.queue.wake();
			return planned;
		},
	};
}
