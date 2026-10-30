import { sha256Hex } from "../../../../infrastructure/digest";
import { LarmError } from "../../../larm";
import {
	listClusterMembers,
	listClusters,
	memberDigest,
	memberKey,
	setClusterState,
	upsertCluster,
	type ClusterInput,
} from "../../../map";
import type { HandlerDefinition, Tx } from "../../../queue";
import {
	DistillError,
	type CalibrationLabel,
	type ClusterModule,
	type DistillDeps,
	type Thresholds,
} from "../../contracts";
import {
	addRunCounts,
	finishRun,
	getRun,
	getThresholds,
	setParam,
	setThresholds,
} from "../../repository";
import { createAssess } from "../assess";
import { agglomerate } from "./agglomerate";
import {
	calibrate,
	sampleCalibration,
	sampleCalibrationYielding,
} from "./calibrate";
import {
	CLUSTER_KIND,
	clusterPayload,
	SCOPE,
	type ClusterPayload,
} from "./job";
import { nearestNeighbors, runYielding } from "./neighbors";
import { assertVectorsUsable, loadPopulation, type Atom } from "./population";
import { placePending, type PlaceCounts } from "./place";

export { agglomerate } from "./agglomerate";
export { BANDS, fitThresholds, sampleCalibration } from "./calibrate";
export { loadPopulation } from "./population";

/** Neighbours per atom whose edges are candidates for a merge (6.3). */
export const CLUSTER_NEIGHBORS = 20;

/** `avglink.v1|t=0.935|cap=12|e=0.930`, with `|unverified` for a pilot on unverified vectors. */
export function algorithmName(t: Thresholds, unverified: boolean): string {
	return `avglink.v1|t=${t.clusterMerge.toFixed(3)}|cap=${t.clusterCap}|e=${t.clusterEdge.toFixed(3)}${unverified ? "|unverified" : ""}`;
}

const clusterId = (digest: string): string =>
	`cl_${sha256Hex(digest).slice(0, 24)}`;

interface FullInput {
	mode: "full";
	runId: string;
	thresholds: Thresholds;
	unverified: boolean;
	/** All rows of the population, in seq order; `vector` set for the usable ones. */
	atoms: Atom[];
	/** A reason to fail the job (the vectors), found while reading. */
	problem: "distill_vectors_unverified" | null;
}
interface PlaceInput {
	mode: "place";
	runId: string;
}
type Input = FullInput | PlaceInput;

interface Group {
	ids: string[];
	similarities: number[];
}
interface Output {
	groups: Group[];
	embedded: number;
}

/**
 * The stages cluster (6.3) and incremental (6.10) and the calibration (6.2).
 * The job `distill.cluster` is the clustering of the whole population (mode `full`) or the
 * placement of the atoms the incremental stage assessed (mode `place`).
 */
export function createCluster(deps: DistillDeps): ClusterModule {
	const at = () => deps.now().toISOString();
	const assess = createAssess(deps);
	/** Thresholds being stored by `applyCalibration`; stages wait for it. */
	let pendingCalibration: Promise<unknown> = Promise.resolve();

	// ---- clustering -----------------------------------------------------------------------

	async function execute(
		input: Input,
		ctx: { signal: AbortSignal },
	): Promise<Output> {
		if (input.mode === "place") {
			const report = await deps.embedKnowledge();
			return { groups: [], embedded: report.embedded };
		}
		if (input.problem) throw new DistillError(input.problem);
		const usable = input.atoms.filter((a) => a.vector);
		if (usable.length < 2) return { groups: [], embedded: 0 };
		const t = input.thresholds;
		const neighbors = await runYielding(
			nearestNeighbors(
				usable.map((a) => a.vector!),
				CLUSTER_NEIGHBORS,
				t.clusterEdge,
			),
		);
		ctx.signal.throwIfAborted();
		const edges: [number, number][] = [];
		neighbors.forEach((list, i) => {
			for (const n of list) edges.push([i, n.index]);
		});
		const clusters = agglomerate({
			vectors: usable.map((a) => a.vector!),
			seqs: usable.map((a) => a.seq),
			edges,
			merge: t.clusterMerge,
			cap: t.clusterCap,
		});
		return {
			embedded: 0,
			groups: clusters.map((indices) => {
				const dim = usable[0]!.vector!.length;
				const centroid = new Float64Array(dim);
				for (const i of indices)
					for (let d = 0; d < dim; d++) centroid[d]! += usable[i]!.vector![d]!;
				const norm = Math.sqrt(centroid.reduce((s, v) => s + v * v, 0)) || 1;
				return {
					ids: indices.map((i) => usable[i]!.id),
					similarities: indices.map((i) => {
						let s = 0;
						for (let d = 0; d < dim; d++)
							s += usable[i]!.vector![d]! * (centroid[d]! / norm);
						return Math.round(s * 1e6) / 1e6;
					}),
				};
			}),
		};
	}

	function settleFull(tx: Tx, input: FullInput, out: Output): void {
		const now = at();
		const algorithm = algorithmName(input.thresholds, input.unverified);
		const byId = new Map(input.atoms.map((a) => [a.id, a]));
		const existing = listClusters(tx, { kind: "claim" });
		const byDigest = new Map(existing.map((c) => [c.memberDigest, c]));
		const counts = {
			population: input.atoms.length,
			usable: input.atoms.filter((a) => a.vector).length,
			unusable: input.atoms.filter((a) => !a.vector).length,
			clusters: out.groups.length,
			clustered: out.groups.reduce((n, g) => n + g.ids.length, 0),
			inserted: 0,
			updated: 0,
			unchanged: 0,
			staled: 0,
			revived: 0,
		};
		const kept = new Set<string>();
		for (const group of out.groups) {
			const members: ClusterInput["members"] = group.ids.map((id, i) => ({
				kind: "knowledge",
				id,
				role: "member",
				similarity: group.similarities[i]!,
			}));
			const digests = new Map(
				group.ids.map((id) => [
					memberKey("knowledge", id),
					byId.get(id)!.contentDigest,
				]),
			);
			const digest = memberDigest(members, digests);
			const known = byDigest.get(digest);
			const id = known?.id ?? clusterId(digest);
			const result = upsertCluster(tx, {
				id,
				kind: "claim",
				parentId: null,
				level: 0,
				name: "",
				aliases: [],
				description: "",
				summary: {},
				state: "pending",
				algorithm,
				memberDigest: digest,
				members,
				createdAt: now,
				updatedAt: now,
			});
			counts[result]++;
			kept.add(id);
			// The same members as a cluster that went stale: it is current again.
			if (known?.state === "stale" && setClusterState(tx, id, "pending", now))
				counts.revived++;
		}
		// A cluster that no longer exists in this composition goes stale, but only while some
		// member is still in the population: a cluster whose members were all absorbed is done.
		for (const old of existing) {
			if (kept.has(old.id) || old.state === "stale") continue;
			const alive = listClusterMembers(tx, old.id).some(
				(m) => m.kind === "knowledge" && byId.has(m.id),
			);
			if (alive && setClusterState(tx, old.id, "stale", now)) counts.staled++;
		}
		addRunCounts(tx, input.runId, {
			...counts,
			singles: counts.usable - counts.clustered,
		});
		finishRun(tx, input.runId, "completed", now);
	}

	function settlePlace(tx: Tx, input: PlaceInput, out: Output): void {
		const counts: PlaceCounts = placePending(tx, deps.spaceKey, at());
		addRunCounts(tx, input.runId, { ...counts, embedded: out.embedded });
		finishRun(tx, input.runId, "completed", at());
	}

	const handler: HandlerDefinition<ClusterPayload, Input, Output> = {
		kind: CLUSTER_KIND,
		payloadVersions: [1],
		schema: clusterPayload,
		recovery: "replay_safe",
		resourceKey: "cpu",
		prepareInTransaction(tx, claim) {
			const run = getRun(tx, claim.payload.runId);
			if (!run || run.state !== "running")
				return { status: "stale", reason: "run_not_running" };
			if (claim.payload.mode === "place")
				return {
					status: "ready",
					input: { mode: "place", runId: run.id },
				};
			const unverified = run.params.allowUnverified === true;
			const population = loadPopulation(tx, deps.spaceKey, {
				allowUnverified: unverified,
				limit:
					typeof run.params.limit === "number" ? run.params.limit : undefined,
			});
			let problem: FullInput["problem"] = null;
			try {
				assertVectorsUsable(population, unverified);
			} catch (error) {
				if (!(error instanceof DistillError)) throw error;
				problem = "distill_vectors_unverified";
			}
			return {
				status: "ready",
				input: {
					mode: "full",
					runId: run.id,
					thresholds: getThresholds(tx),
					unverified,
					atoms: population.atoms,
					problem,
				},
			};
		},
		execute,
		classify: (error) =>
			error instanceof LarmError &&
			(error.code === "larm_busy" ||
				error.code === "larm_unreachable" ||
				error.code === "larm_deploying")
				? "retry"
				: "fail",
		settleInTransaction(tx, claim, input, outcome) {
			if (outcome.type === "retry") return "applied";
			if (outcome.type !== "success" || !input) {
				finishRun(tx, claim.payload.runId, "failed", at());
				return "applied";
			}
			const run = getRun(tx, claim.payload.runId);
			if (!run || run.state !== "running") return "stale";
			if (input.mode === "full") settleFull(tx, input, outcome.result);
			else settlePlace(tx, input, outcome.result);
			return "applied";
		},
		cancelInTransaction(tx, job) {
			finishRun(tx, job.payload.runId, "cancelled", at());
		},
	};

	// ---- calibration --------------------------------------------------------------------

	/** Computes the thresholds now and starts storing them; `done` resolves once stored. */
	function storeCalibration(labels: CalibrationLabel[]): {
		thresholds: Thresholds;
		done: Promise<void>;
	} {
		const now = at();
		const { thresholds, detail } = deps.store.read((db) =>
			calibrate(db, deps.spaceKey, labels, getThresholds(db), now),
		);
		const done = deps.store.write((db) => {
			setThresholds(db, thresholds, now);
			setParam(db, "calibration", { ...detail, at: now }, now);
		});
		// A stage waits for the write before it reads the thresholds.
		pendingCalibration = done.catch((error) =>
			deps.log(
				`distill.calibration_write_failed ${(error as { code?: unknown } | null)?.code ?? "unknown"}`,
			),
		);
		return { thresholds, done };
	}

	return {
		registerHandlers() {
			deps.queue.registerHandler(handler);
		},
		async start(stage, runId, opts) {
			if (stage === "incremental") return assess.start(stage, runId, opts);
			if (stage !== "cluster")
				throw new DistillError("invalid_distill_request");
			await pendingCalibration;
			const population = deps.store.read((db) =>
				loadPopulation(db, deps.spaceKey, {
					allowUnverified: opts.allowUnverified,
					limit: opts.limit,
				}),
			);
			assertVectorsUsable(population, opts.allowUnverified);
			if (population.usable.length < 2) return 0;
			if (opts.dryRun) return 1;
			await deps.queue.enqueue({
				scope: SCOPE,
				kind: CLUSTER_KIND,
				dedupeKey: `cluster:${runId}`,
				payload: { runId },
				subjectRef: `cluster:${runId}`,
				lane: "background",
				resourceKey: "cpu",
				maxAttempts: 3,
			});
			return 1;
		},
		calibrationSample: (n) =>
			deps.store.read((db) => sampleCalibration(db, deps.spaceKey, n)),
		calibrationSampleYielding: (n) =>
			sampleCalibrationYielding((op) => deps.store.read(op), deps.spaceKey, n),
		// Bad labels throw before anything is queued; the promise settles with the write.
		applyCalibration(labels) {
			const { thresholds, done } = storeCalibration(labels);
			return done.then(() => thresholds);
		},
	};
}
