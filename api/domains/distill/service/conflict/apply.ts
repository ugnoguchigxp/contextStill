import type { Database } from "bun:sqlite";
import { DistillError } from "../../contracts";
import { sha256Hex } from "../../../../infrastructure/digest";
import { makeHandle } from "../../../../infrastructure/handle";
import {
	getKnowledgeById,
	listSupersededBy,
	setKnowledgeDisposition,
	upsertKnowledgeItem,
	type KnowledgeInput,
	type KnowledgeRow,
} from "../../../knowledge";
import {
	getCluster,
	memberDigest,
	memberKey,
	upsertCluster,
	upsertEdge,
	type ClusterMember,
} from "../../../map";
import {
	insertReview,
	listPairJudgments,
	setPairResolution,
} from "../../repository";
import { canonicalsOfCluster } from "./reads";
import {
	canonicalAtomIds,
	type StrengthInputs,
	type StrengthScore,
} from "./strength";

export const MERGE_ALGORITHM = "conflict-merge-v1";
export const CONFLICT_EXTRACTOR = "conflict-v1";
export const MAX_NOT_APPLIES = 8;

const isActive = (row: KnowledgeRow | null): row is KnowledgeRow =>
	row !== null && row.status === "active";

export const isActiveCanonical = (
	row: KnowledgeRow | null,
): row is KnowledgeRow => isActive(row) && row.layer === "canonical";

export const mergeClusterId = (a: string, b: string): string =>
	`cl_merge_${sha256Hex(`${a}|${b}`).slice(0, 24)}`;

/**
 * The id of a review about a pair: one review per pair, kind and pair of texts. The digests are
 * part of it, so a pair that is judged again after a text changed (or after the owner settled
 * the earlier review) opens a new review instead of hitting the settled one.
 */
export const pairReviewId = (
	kind: string,
	a: string,
	b: string,
	aDigest: string,
	bDigest: string,
): string =>
	`${kind}:${a}:${b}:${aDigest.slice(0, 16)}:${bDigest.slice(0, 16)}`;

export function pairSubject(db: Database, a: string, b: string) {
	const x = getKnowledgeById(db, a);
	const y = getKnowledgeById(db, b);
	return {
		type: "pair" as const,
		a,
		b,
		aHandle: x?.handle ?? makeHandle("knowledge", a),
		bHandle: y?.handle ?? makeHandle("knowledge", b),
		aTitle: x?.title ?? "",
		bTitle: y?.title ?? "",
		aDigest: x?.contentDigest ?? "",
		bDigest: y?.contentDigest ?? "",
	};
}

/** Adds the conditions to `notAppliesWhen` (existing ones first, at most 8). True when the row changed. */
export function addNotAppliesWhen(
	db: Database,
	id: string,
	added: readonly string[],
	at: string,
): boolean {
	const row = getKnowledgeById(db, id);
	if (!row) return false;
	const merged = [...row.notAppliesWhen];
	for (const c of added) {
		const t = c.trim();
		if (t !== "" && !merged.includes(t) && merged.length < MAX_NOT_APPLIES)
			merged.push(t);
	}
	if (merged.length === row.notAppliesWhen.length) return false;
	const input: KnowledgeInput = {
		id: row.id,
		layer: row.layer,
		type: row.type,
		polarity: row.polarity,
		title: row.title,
		body: row.body,
		situation: row.situation,
		rationale: row.rationale,
		exceptions: row.exceptions,
		examples: row.examples,
		appliesWhen: row.appliesWhen,
		notAppliesWhen: merged,
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
	return upsertKnowledgeItem(db, input) !== "unchanged";
}

/** condition_split: both canonicals stay, each gets the conditions under which it does not apply. */
export function applySplit(
	db: Database,
	a: string,
	b: string,
	aAdd: readonly string[],
	bAdd: readonly string[],
	at: string,
): void {
	addNotAppliesWhen(db, a, aAdd, at);
	addNotAppliesWhen(db, b, bAdd, at);
	setPairResolution(db, a, b, "split", at);
}

/**
 * The loser of a conflict leaves search (`retracted`, `evidence_only`). Its atoms were folded
 * into it; an atom no active or superseded canonical still stands for is retracted with it, so
 * that every superseded atom keeps a canonical to trace to (audit, 6.6).
 */
export function retractCanonical(db: Database, id: string, at: string): void {
	setKnowledgeDisposition(db, id, {
		status: "retracted",
		retrieval: "evidence_only",
		updatedAt: at,
	});
	for (const atomId of canonicalAtomIds(db, id)) {
		const atom = getKnowledgeById(db, atomId);
		if (
			atom?.status === "superseded" &&
			listSupersededBy(db, atomId).length === 0
		)
			setKnowledgeDisposition(db, atomId, {
				status: "retracted",
				updatedAt: at,
			});
	}
}

/**
 * conflict decided: the weaker side is retracted, `contradicts` (winner to loser) is recorded
 * and so is the resolution. `origin` is `llm` for the automatic rule, `human` for the owner.
 */
export function applyWinner(
	db: Database,
	args: {
		a: string;
		b: string;
		winner: "a" | "b";
		origin: "llm" | "human";
		evidence: Record<string, unknown>;
		at: string;
	},
): void {
	// Both sides must still be active canonicals: a side that is already superseded or
	// retracted is not overwritten.
	if (
		!isActiveCanonical(getKnowledgeById(db, args.a)) ||
		!isActiveCanonical(getKnowledgeById(db, args.b))
	)
		throw new DistillError("invalid_distill_request");
	const [win, lose] = args.winner === "a" ? [args.a, args.b] : [args.b, args.a];
	retractCanonical(db, lose, args.at);
	upsertEdge(db, {
		src: { kind: "knowledge", id: win },
		relation: "contradicts",
		dst: { kind: "knowledge", id: lose },
		origin: args.origin,
		status: "active",
		confidence: args.origin === "human" ? 1 : 0.7,
		evidence: args.evidence,
		extractorVersion: CONFLICT_EXTRACTOR,
		at: args.at,
	});
	setPairResolution(
		db,
		args.a,
		args.b,
		args.winner === "a" ? "a_wins" : "b_wins",
		args.at,
	);
}

/** The strength figures a conflict review shows the owner. */
export function strengthProposal(
	a: StrengthInputs & StrengthScore,
	b: StrengthInputs & StrengthScore,
) {
	const part = (s: StrengthInputs & StrengthScore) => ({
		atoms: s.atoms,
		records: s.records,
		used: s.used,
		latest: s.latest,
		importance: s.importance,
		recency: s.recency,
		score: Math.round(s.score * 1000) / 1000,
	});
	return { a: part(a), b: part(b) };
}

export function openPairReview(
	db: Database,
	args: {
		kind: "conflict" | "verifier_unknown";
		a: string;
		b: string;
		proposal: Record<string, unknown>;
		at: string;
	},
): boolean {
	const subject = pairSubject(db, args.a, args.b);
	return insertReview(db, {
		id: pairReviewId(
			args.kind,
			args.a,
			args.b,
			subject.aDigest,
			subject.bDigest,
		),
		kind: args.kind,
		subject,
		proposal: args.proposal,
		at: args.at,
	});
}

/**
 * duplicate: a new claim cluster of the union of the two canonicals' evidence atoms. It is
 * `pending`; the canonical stage distills it, and `reconcileMerges` then supersedes the old
 * canonicals. Returns the cluster id, or null when the two have no atoms at all.
 */
export function openMergeCluster(
	db: Database,
	a: string,
	b: string,
	at: string,
): string | null {
	const ids = [
		...new Set([...canonicalAtomIds(db, a), ...canonicalAtomIds(db, b)]),
	]
		.filter((id) => getKnowledgeById(db, id) !== null)
		.sort();
	if (ids.length === 0) return null;
	const members: ClusterMember[] = ids.map((id) => ({
		kind: "knowledge",
		id,
		role: "member",
		similarity: null,
	}));
	const digests = new Map(
		ids.map((id) => [
			memberKey("knowledge", id),
			getKnowledgeById(db, id)!.contentDigest,
		]),
	);
	const id = mergeClusterId(a, b);
	upsertCluster(db, {
		id,
		kind: "claim",
		parentId: null,
		level: 0,
		name: "merge of duplicate canonicals",
		aliases: [],
		description: "",
		summary: { mergeOf: [a, b] },
		state: "pending",
		algorithm: MERGE_ALGORITHM,
		memberDigest: memberDigest(members, digests),
		members,
		createdAt: at,
		updatedAt: at,
	});
	return id;
}

/**
 * The new canonical an old one is superseded by: the one that shares the most evidence atoms
 * with it (the newest on a tie, and when they share none).
 */
function bestSuccessor(
	db: Database,
	old: string,
	made: readonly { id: string }[],
): string {
	const oldAtoms = new Set(canonicalAtomIds(db, old));
	let best = made[0]!.id;
	let bestShared = -1;
	for (const c of made) {
		const shared = canonicalAtomIds(db, c.id).filter((id) =>
			oldAtoms.has(id),
		).length;
		if (shared > bestShared) {
			best = c.id;
			bestShared = shared;
		}
	}
	return best;
}

/**
 * Finishes the duplicates whose merge cluster the canonical stage has distilled: the old
 * canonicals other than the new one become `superseded` and are linked from it (`supersedes`,
 * new to old). A cluster the canonical stage sent to review hands the pair to the owner.
 * Returns how many pairs were merged.
 */
export function reconcileMerges(db: Database, at: string): number {
	let merged = 0;
	for (const j of listPairJudgments(db, {
		verdict: "duplicate",
		resolution: "none",
	})) {
		const cluster = getCluster(db, mergeClusterId(j.aId, j.bId));
		if (!cluster) continue;
		if (cluster.state === "review" || cluster.state === "rejected") {
			setPairResolution(db, j.aId, j.bId, "owner_pending", at);
			continue;
		}
		if (cluster.state !== "distilled") continue;
		const made = canonicalsOfCluster(db, cluster.id).filter(
			(c) => c.status === "active",
		);
		if (made.length === 0) continue;
		const madeIds = new Set(made.map((c) => c.id));
		for (const old of [j.aId, j.bId]) {
			// The canonical stage reused this id for one of the new canonicals: it stays.
			if (madeIds.has(old)) continue;
			const row = getKnowledgeById(db, old);
			if (!isActive(row)) continue;
			const successor = bestSuccessor(db, old, made);
			setKnowledgeDisposition(db, old, {
				status: "superseded",
				retrieval: "evidence_only",
				updatedAt: at,
			});
			upsertEdge(db, {
				src: { kind: "knowledge", id: successor },
				relation: "supersedes",
				dst: { kind: "knowledge", id: old },
				origin: "llm",
				status: "active",
				confidence: 0.8,
				evidence: { reason: "duplicate", cluster: cluster.id },
				extractorVersion: CONFLICT_EXTRACTOR,
				at,
			});
		}
		setPairResolution(db, j.aId, j.bId, "merged", at);
		merged++;
	}
	return merged;
}
