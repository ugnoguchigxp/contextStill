import { randomUUID } from "node:crypto";
import {
	DistillError,
	type AssessModule,
	type AuditModule,
	type CanonicalModule,
	type ClusterModule,
	type ConflictModule,
	type DistillDeps,
	type DistillService,
	type DistillStage,
	type ExamplesModule,
	type ReviewModule,
	type StageModule,
	type StartStageOptions,
	type ThemeModule,
} from "../contracts";
import {
	createRun,
	failRunningRuns,
	finishRun,
	findRunningRun,
} from "../repository";
import { createAssess } from "./assess";
import { createAudit } from "./audit";
import { acceptReviewedDraft, createCanonical } from "./canonical";
import { createCluster } from "./cluster";
import { createConflict } from "./conflict";
import { createExamples } from "./examples";
import { createReview } from "./review";
import { createTheme } from "./theme";

export { callJson } from "./llm";

/** Job states that can still settle a run (the queue's open states). */
const OPEN_JOB_STATES = [
	"queued",
	"running",
	"retry_wait",
	"cancel_requested",
] as const;

export interface DistillModules {
	assess: AssessModule;
	cluster: ClusterModule;
	canonical: CanonicalModule;
	conflict: ConflictModule;
	review: ReviewModule;
	audit: AuditModule;
	theme: ThemeModule;
	examples: ExamplesModule;
}

/**
 * Wires the stage modules into the `DistillService` of 5.6. Each module is written by its own
 * workstream behind the interface in contracts; this file only routes and keeps the run rows.
 * A stage's jobs finish their run: the module that enqueues them adds to its counters
 * (`addRunCounts`) and calls `finishRun` when the last one settles.
 */
export function createDistill(
	deps: DistillDeps,
	/** Replaces modules; for tests of the routing. */
	modules: Partial<DistillModules> = {},
): DistillService {
	const assess = modules.assess ?? createAssess(deps);
	const cluster = modules.cluster ?? createCluster(deps);
	const canonical = modules.canonical ?? createCanonical(deps);
	const conflict = modules.conflict ?? createConflict(deps);
	// The owner adopting a canonical draft goes through the canonical stage's own settle.
	const review =
		modules.review ?? createReview(deps, { acceptDraft: acceptReviewedDraft });
	const audit = modules.audit ?? createAudit(deps);
	const theme = modules.theme ?? createTheme(deps);
	const examples = modules.examples ?? createExamples(deps);

	const byStage: Record<DistillStage, StageModule> = {
		assess,
		cluster,
		incremental: cluster,
		canonical,
		embed: canonical,
		conflict,
		theme,
		examples,
	};

	return {
		registerHandlers() {
			for (const module of [
				assess,
				cluster,
				canonical,
				conflict,
				theme,
				examples,
			])
				module.registerHandlers();
		},
		async startStage(stage: DistillStage, opts: StartStageOptions) {
			const module = byStage[stage];
			if (
				!module ||
				(opts.limit !== undefined &&
					(!Number.isInteger(opts.limit) || opts.limit < 1))
			)
				throw new DistillError("invalid_distill_request");
			const runId = `run_${randomUUID()}`;
			await deps.store.write((db) => {
				if (findRunningRun(db, stage))
					throw new DistillError("distill_stage_running");
				createRun(db, {
					id: runId,
					stage,
					params: { ...opts },
					at: deps.now().toISOString(),
				});
			});
			const finish = (state: "completed" | "failed") =>
				deps.store.write((db) =>
					finishRun(db, runId, state, deps.now().toISOString()),
				);
			let enqueued: number;
			try {
				enqueued = await module.start(stage, runId, opts);
			} catch (error) {
				await finish("failed");
				throw error;
			}
			// Nothing to wait for: a dry run, or a stage with no job to run.
			if (opts.dryRun || enqueued === 0) await finish("completed");
			return { runId, enqueued };
		},
		status: () => review.status(),
		calibrationSample: (n) => cluster.calibrationSampleYielding(n),
		applyCalibration: (labels) => cluster.applyCalibration(labels),
		listReviews: (state) => review.listReviews(state),
		resolveReview: (id, decision, signal) =>
			review.resolveReview(id, decision, signal),
		audit: () => audit.auditYielding(),
		judgePairs: (pairs, signal) => conflict.judgePairs(pairs, signal),
		async recoverRuns() {
			const open = OPEN_JOB_STATES.some(
				(state) =>
					deps.queue.list({ scope: "distill", state }, null, 1).items.length >
					0,
			);
			if (open) return 0;
			const at = deps.now().toISOString();
			return deps.store.write((db) => failRunningRuns(db, at));
		},
	};
}
