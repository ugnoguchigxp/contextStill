import { z } from "zod";
import type { Tx } from "../../../queue";
import type { DistillDeps } from "../../contracts";

export const CLUSTER_KIND = "distill.cluster";
export const SCOPE = "distill";

/**
 * `full`: cluster the whole population (stage cluster). `place`: put the atoms of the
 * incremental stage into the existing clusters (6.10).
 */
export const clusterPayload = z.object({
	runId: z.string().min(1),
	mode: z.enum(["full", "place"]).optional(),
});
export type ClusterPayload = z.infer<typeof clusterPayload>;

/** The placement of the incremental stage; it embeds first, so it takes the embedding slot. */
export function enqueuePlaceInTransaction(
	deps: Pick<DistillDeps, "queue">,
	tx: Tx,
	runId: string,
): void {
	deps.queue.enqueueInTransaction(tx, {
		scope: SCOPE,
		kind: CLUSTER_KIND,
		dedupeKey: `place:${runId}`,
		payload: { runId, mode: "place" },
		subjectRef: `place:${runId}`,
		lane: "background",
		resourceKey: "embedding",
		maxAttempts: 3,
	});
}
