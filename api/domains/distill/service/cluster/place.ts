import type { Database } from "bun:sqlite";
import { unpackVector } from "../../../../infrastructure/vector";
import { getKnowledgeById } from "../../../knowledge";
import {
	clustersOfMember,
	getCluster,
	listClusterMembers,
	listClusters,
	memberDigest,
	memberKey,
	upsertCluster,
	type ClusterMember,
} from "../../../map";
import {
	getAssessment,
	getThresholds,
	upsertAssessment,
} from "../../repository";
import { quantize } from "./agglomerate";
import { normalize } from "./population";

interface Indexed {
	id: string;
	members: ClusterMember[];
	/** Sum of the normalised vectors of the members that have one. */
	sum: Float64Array;
	withVector: number;
}

export interface PlaceCounts {
	placed: number;
	singles: number;
	regrouped: number;
	awaitingVector: number;
	skipped: number;
}

const ownVector = (
	db: Database,
	spaceKey: string,
	id: string,
): { vector: Float32Array; digest: string; usable: boolean } | null => {
	const row = db
		.query(
			`SELECT vector, content_digest AS digest, origin, verification FROM vectors
			 WHERE owner_kind = 'knowledge' AND owner_id = ? AND space_key = ?`,
		)
		.get(id, spaceKey) as {
		vector: Uint8Array;
		digest: string;
		origin: string;
		verification: string;
	} | null;
	if (!row) return null;
	return {
		vector: normalize(unpackVector(row.vector)),
		digest: row.digest,
		usable:
			row.verification !== "mismatch" &&
			row.verification !== "stale" &&
			(row.origin === "larm" || row.verification === "verified"),
	};
};

const dotWith = (x: Float32Array, sum: Float64Array): number => {
	let s = 0;
	for (let i = 0; i < x.length; i++) s += x[i]! * sum[i]!;
	return s;
};

/**
 * Puts a distilled claim cluster back to `pending` with the member digest of the text its
 * members have now, so the canonical stage distils it again (and keeps the id of the canonical
 * made from it by overlap). A cluster in any other state is left alone: pending ones are about to
 * be distilled (their member digest is refreshed), and review, rejected and stale ones wait for a
 * person or the next cluster stage. Returns whether the cluster was `distilled` before. The caller owns the transaction.
 */
export function reopenCluster(
	db: Database,
	clusterId: string,
	now: string,
	members?: readonly ClusterMember[],
): boolean {
	const row = getCluster(db, clusterId);
	if (
		!row ||
		row.kind !== "claim" ||
		(row.state !== "distilled" && row.state !== "pending")
	)
		return false;
	const list = members ?? listClusterMembers(db, clusterId);
	const digests = new Map<string, string>();
	for (const m of list)
		digests.set(
			memberKey(m.kind, m.id),
			m.kind === "knowledge"
				? (getKnowledgeById(db, m.id)?.contentDigest ?? "")
				: "",
		);
	upsertCluster(db, {
		id: row.id,
		kind: "claim",
		parentId: row.parentId,
		level: row.level,
		name: row.name,
		aliases: row.aliases,
		description: row.description,
		summary: row.summary,
		state: "pending",
		algorithm: row.algorithm,
		memberDigest: memberDigest(list, digests),
		members: [...list],
		createdAt: row.createdAt,
		updatedAt: now,
	});
	return row.state === "distilled";
}

/**
 * The placement of the incremental stage (6.10), inside the caller's transaction. Each atom
 * assessed by the stage (`signals.placement = 'pending'`) that is general or generalizable and
 * has a usable vector joins the existing claim cluster with the highest average link (the mean
 * cosine to its members) when that is at least `clusterMerge` and the cluster has room under
 * `clusterCap`. Only a `distilled` cluster of the cluster stage takes an atom (not a pending,
 * review, rejected or stale one, and not a merge cluster of the conflict stage). The cluster is
 * then `pending` with a new member digest (the canonical stage distils it again). An atom that
 * was already in a cluster stays out of any other: its distilled clusters go `pending`, because
 * the text they were made from changed. An atom that fits nowhere is a single; the canonical
 * stage takes it from there. Atoms of the `personal` space are never placed.
 * Atoms still without a usable vector stay pending.
 */
export function placePending(
	db: Database,
	spaceKey: string,
	now: string,
): PlaceCounts {
	const counts: PlaceCounts = {
		placed: 0,
		singles: 0,
		regrouped: 0,
		awaitingVector: 0,
		skipped: 0,
	};
	const ids = (
		db
			.query(
				`SELECT owner_id AS id FROM distill_assessments
				 WHERE owner_kind = 'knowledge' AND json_extract(signals_json, '$.placement') = 'pending'
				 ORDER BY owner_id`,
			)
			.all() as { id: string }[]
	).map((r) => r.id);
	if (ids.length === 0) return counts;
	const thresholds = getThresholds(db);

	let index: Indexed[] | null = null;
	const build = (): Indexed[] =>
		listClusters(db, { kind: "claim", state: "distilled" })
			.filter((c) => c.algorithm.startsWith("avglink."))
			.map((c) => {
				const members = listClusterMembers(db, c.id);
				let sum: Float64Array | null = null;
				let withVector = 0;
				for (const m of members) {
					if (m.kind !== "knowledge") continue;
					const own = ownVector(db, spaceKey, m.id);
					if (!own) continue;
					sum ??= new Float64Array(own.vector.length);
					for (let d = 0; d < sum.length; d++) sum[d]! += own.vector[d]!;
					withVector++;
				}
				return {
					id: c.id,
					members,
					sum: sum ?? new Float64Array(0),
					withVector,
				};
			});

	const mark = (id: string, placement: string) => {
		const row = getAssessment(db, "knowledge", id);
		if (!row) return;
		upsertAssessment(db, {
			...row,
			signals: { ...row.signals, placement },
			at: now,
		});
	};

	for (const id of ids) {
		const item = getKnowledgeById(db, id);
		const assessment = getAssessment(db, "knowledge", id);
		if (
			!item ||
			item.layer !== "atom" ||
			item.status !== "active" ||
			item.retrieval !== "searchable" ||
			item.space === "personal" ||
			!assessment ||
			assessment.contentDigest !== item.contentDigest ||
			(assessment.generality !== "general" &&
				assessment.generality !== "generalizable")
		) {
			counts.skipped++;
			mark(id, "skipped");
			continue;
		}
		const own = ownVector(db, spaceKey, id);
		if (!own || !own.usable || own.digest !== item.contentDigest) {
			counts.awaitingVector++;
			continue;
		}
		const inClusters = clustersOfMember(db, "knowledge", id, "claim");
		if (inClusters.length > 0) {
			for (const cid of inClusters)
				if (reopenCluster(db, cid, now)) counts.regrouped++;
			mark(id, "regrouped");
			continue;
		}

		index ??= build();
		let best: { cluster: Indexed; avg: number } | null = null;
		for (const cluster of index) {
			if (
				cluster.withVector === 0 ||
				cluster.members.length >= thresholds.clusterCap
			)
				continue;
			const avg = quantize(
				dotWith(own.vector, cluster.sum) / cluster.withVector,
			);
			if (!best || avg > best.avg) best = { cluster, avg };
		}
		if (!best || best.avg < quantize(thresholds.clusterMerge)) {
			counts.singles++;
			mark(id, "single");
			continue;
		}

		const target = best.cluster;
		if (target.sum.length === 0)
			target.sum = new Float64Array(own.vector.length);
		for (let d = 0; d < own.vector.length; d++)
			target.sum[d]! += own.vector[d]!;
		target.withVector++;
		const norm = Math.sqrt(target.sum.reduce((s, v) => s + v * v, 0)) || 1;
		let similarity = 0;
		for (let d = 0; d < own.vector.length; d++)
			similarity += own.vector[d]! * (target.sum[d]! / norm);
		target.members = [
			...target.members,
			{
				kind: "knowledge",
				id,
				role: "member",
				similarity: Math.round(similarity * 1e6) / 1e6,
			},
		];
		reopenCluster(db, target.id, now, target.members);
		counts.placed++;
		mark(id, "placed");
	}
	return counts;
}
