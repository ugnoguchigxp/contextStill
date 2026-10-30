import type { Database } from "bun:sqlite";
import { listClusters, type ClusterState } from "../../../map";
import type { DistillStatus } from "../../contracts";
import {
	countAssessmentsByGenerality,
	countOpenReviewsByKind,
	llmCallTotals,
} from "../../repository";
import {
	listActiveCanonicals,
	atomCounts,
	canonicalStatusCounts,
} from "../conflict/reads";
import { getVector } from "../../../vectors";
import type { QueueStatus } from "../../../queue";

/** The status report (5.6). Everything is counted from the tables; nothing is cached. */
export function buildStatus(
	db: Database,
	spaceKey: string,
	queue: QueueStatus,
): DistillStatus {
	const clusters: DistillStatus["clusters"] = {
		pending: 0,
		distilled: 0,
		review: 0,
		rejected: 0,
		stale: 0,
	};
	for (const c of listClusters(db, { kind: "claim" }))
		clusters[c.state as ClusterState]++;
	const counts = canonicalStatusCounts(db);
	let withoutVector = 0;
	for (const c of listActiveCanonicals(db)) {
		const v = getVector(db, "knowledge", c.id, spaceKey);
		if (!v || v.contentDigest !== c.contentDigest) withoutVector++;
	}
	return {
		atoms: atomCounts(db),
		assessments: countAssessmentsByGenerality(db),
		clusters,
		canonicals: { ...counts, withoutVector },
		reviews: countOpenReviewsByKind(db),
		llm: llmCallTotals(db),
		queue,
	};
}
