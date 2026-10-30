import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { Space } from "../../../../infrastructure/scope";
import {
	getKnowledgeById,
	knowledgeContentDigest,
	listKnowledgeEvidence,
	listSupersededBy,
	replaceKnowledgeEvidence,
	setKnowledgeDisposition,
	upsertKnowledgeItem,
	type EvidenceInput,
	type KnowledgeRow,
	type ProvenanceStatus,
	type Retrieval,
} from "../../../knowledge";
import { getCluster, setClusterState, upsertEdge } from "../../../map";
import { lintFacets, repoSignals, hasAnySignal } from "../checks";
import type { DistillDeps, ReviewKind } from "../../contracts";
import { CANONICAL_PROMPT_VERSION } from "../../prompts/canonical-plan";
import {
	getAssessment,
	getPairJudgment,
	insertReview,
	upsertAssessment,
	upsertPairJudgment,
} from "../../repository";
import { atomUsable, isUnverifiedAlgorithm, reviewId } from "./reads";
import type {
	AtomView,
	CanonicalPayload,
	GroupResult,
	UnitInput,
	UnitResult,
} from "./types";

type Counts = Record<string, number>;
const bump = (c: Counts, key: string, n = 1) => {
	c[key] = (c[key] ?? 0) + n;
};

/** A new group id is reused when it shares at least this share of its members with an old canonical. */
export const JACCARD_REUSE = 0.5;

export interface SettleResult {
	status: "applied" | "stale";
	counts: Counts;
}

/**
 * The single write of a canonical job (6.4 settle). It runs inside the queue's one writer
 * transaction: a throw rolls everything back, so nothing of the job is written. Stale input
 * (the cluster or an atom changed since the job was prepared) writes nothing for that part.
 */
export function settleUnit(
	db: Database,
	deps: DistillDeps,
	payload: CanonicalPayload,
	input: UnitInput,
	result: UnitResult,
): SettleResult {
	const counts: Counts = {};
	const at = deps.now().toISOString();
	if (input.kind === "cluster") {
		const cluster = getCluster(db, input.clusterId!);
		if (
			!cluster ||
			cluster.state !== "pending" ||
			isUnverifiedAlgorithm(cluster.algorithm) ||
			!("clusterId" in payload) ||
			cluster.memberDigest !== payload.memberDigest
		) {
			bump(counts, "stale");
			return { status: "stale", counts };
		}
	}
	const byAlias = new Map(input.atoms.map((a) => [a.alias, a]));
	const claimedIds = new Set<string>();
	// group index -> adopted canonical
	const adopted = new Map<number, { id: string; digest: string }>();
	let allSettled = true;

	for (const group of result.groups) {
		const members = group.members
			.map((a) => byAlias.get(a))
			.filter((a): a is AtomView => a !== undefined);
		if (!members.every((a) => atomUnchanged(db, a, input))) {
			bump(counts, "staleGroups");
			allSettled = false;
			continue;
		}
		if (group.kind === "canonical") {
			const made = writeCanonical(db, input, group, members, claimedIds, at);
			if (group.index !== null) adopted.set(group.index, made);
			bump(counts, "canonicals");
			if (made.reused) bump(counts, "reusedIds");
			bump(counts, "superseded", members.length);
			if (group.polarityTie) {
				insertReview(db, {
					id: reviewId("low_confidence", [
						{ id: made.id, contentDigest: made.digest },
					]),
					kind: "low_confidence",
					subject: {
						canonicalId: made.id,
						handle: made.handle,
						atomIds: members.map((a) => a.row.id),
						reason: "polarity_tie",
					},
					proposal: { plannerCallId: group.plannerCallId },
					at,
				});
				bump(counts, "reviews");
			}
		} else if (group.kind === "disposition") {
			let confirmed = 0;
			for (const atom of members)
				if (
					writeDisposition(
						db,
						atom,
						group.disposition,
						group.plannerCallId,
						input.repoTerms,
						at,
						counts,
					)
				)
					confirmed++;
			if (confirmed > 0) bump(counts, group.disposition);
		} else {
			allSettled = false;
			const kind: ReviewKind = group.review;
			const created = insertReview(db, {
				id: reviewId(
					kind,
					members.map((a) => ({
						id: a.row.id,
						contentDigest: a.row.contentDigest,
					})),
				),
				kind,
				subject: {
					clusterId: input.clusterId,
					atomIds: members.map((a) => a.row.id),
					handles: members.map((a) => a.row.handle),
					reason: group.reason,
				},
				proposal: reviewProposal(group, byAlias),
				at,
			});
			if (created) bump(counts, "reviews");
			bump(counts, kind);
		}
	}

	writeRelations(db, deps, input, result, adopted, counts, at);
	bump(counts, "relationsDropped", result.relationsDropped);

	if (input.kind === "cluster")
		setClusterState(
			db,
			input.clusterId!,
			allSettled ? "distilled" : counts.staleGroups ? "pending" : "review",
			at,
		);
	return { status: "applied", counts };
}

function atomUnchanged(
	db: Database,
	atom: AtomView,
	input: UnitInput,
): boolean {
	const row = getKnowledgeById(db, atom.row.id);
	return (
		row !== null &&
		row.contentDigest === atom.row.contentDigest &&
		atomUsable(db, row, { merge: input.merge, clusterId: input.clusterId })
	);
}

/** The proposal of a review: what the owner needs to accept the draft, with ids instead of aliases. */
function reviewProposal(
	group: Extract<GroupResult, { kind: "review" }>,
	byAlias: ReadonlyMap<string, AtomView>,
): Record<string, unknown> {
	const idOf = (alias: string) => byAlias.get(alias)?.row.id ?? alias;
	return {
		promptVersion: CANONICAL_PROMPT_VERSION,
		reason: group.reason,
		draft: group.draft
			? {
					...group.draft,
					claims: group.draft.claims.map((c) => ({
						text: c.text,
						supportIds: c.support.map(idOf),
					})),
				}
			: null,
		violations: group.violations.map((v) => ({
			code: v.code,
			detail: v.detail,
		})),
		verifier: group.verifier,
		plannerCallId: group.plannerCallId,
		verifierCallId: group.verifierCallId,
	};
}

const EXCLUDING: ReadonlySet<string> = new Set(["repo_specific", "unusable"]);

/** The text an atom's own signs (repo names, paths, ports) are looked for in. */
function atomSignText(atom: AtomView): string {
	const r = atom.row;
	return [
		r.title,
		r.body,
		r.situation ?? "",
		...r.appliesWhen,
		...r.notAppliesWhen,
		...r.steps,
	].join("\n");
}

/**
 * repo_specific / unusable from the planner. The atom leaves search only when something other
 * than the planner's word agrees: the generality assessment already says so (or a person did),
 * or the text carries a repo name, a path or a port. Otherwise the atom is left as it is and
 * the owner decides (a `generality` review). Returns true when the atom was settled.
 */
function writeDisposition(
	db: Database,
	atom: AtomView,
	generality: "repo_specific" | "unusable",
	callId: string,
	repoTerms: readonly string[],
	at: string,
	counts: Counts,
): boolean {
	const before = getAssessment(db, "knowledge", atom.row.id);
	const humanDisagrees =
		before?.origin === "human" && before.generality !== generality;
	const agrees =
		before !== null &&
		before.contentDigest === atom.row.contentDigest &&
		EXCLUDING.has(before.generality);
	const signs = hasAnySignal(repoSignals(atomSignText(atom), repoTerms));
	if (humanDisagrees || (!agrees && !signs)) {
		// A person's judgment is not overwritten, and a lone planner verdict does not hide an
		// atom the assessment found usable: the disagreement goes to the owner.
		const created = insertReview(db, {
			id: reviewId("generality", [
				{ id: atom.row.id, contentDigest: atom.row.contentDigest },
			]),
			kind: "generality",
			// ownerKind/ownerId are what the review module resolves `set_generality` against.
			subject: {
				ownerKind: "knowledge",
				ownerId: atom.row.id,
				atomIds: [atom.row.id],
				handles: [atom.row.handle],
			},
			proposal: {
				generality,
				current: before?.generality ?? null,
				origin: before?.origin ?? null,
				callId,
			},
			at,
		});
		if (created) bump(counts, "reviews");
		bump(counts, "generalityReviews");
		return false;
	}
	upsertAssessment(db, {
		ownerKind: "knowledge",
		ownerId: atom.row.id,
		generality,
		signals: before?.signals ?? {},
		reason: "canonical planner",
		origin: "llm",
		contentDigest: atom.row.contentDigest,
		promptVersion: CANONICAL_PROMPT_VERSION,
		callId,
		at,
	});
	setKnowledgeDisposition(db, atom.row.id, {
		retrieval: "evidence_only" satisfies Retrieval,
		updatedAt: at,
	});
	bump(counts, "evidenceOnly");
	return true;
}

const uniqueSorted = (values: Iterable<string>) => [...new Set(values)].sort();

/**
 * The facets of a canonical from its members': string arrays are united, any other value is the
 * latest member's (by `updatedAt`, then id), so the choice never depends on read order. Values
 * with a repo name, a path or a port are left out: the canonical is global.
 */
export function mergeFacets(
	members: readonly Pick<KnowledgeRow, "id" | "facets" | "updatedAt">[],
	repoTerms: readonly string[] = [],
): { facets: Record<string, unknown>; dropped: number } {
	const latestFirst = [...members].sort((a, b) =>
		a.updatedAt === b.updatedAt
			? a.id < b.id
				? 1
				: -1
			: a.updatedAt < b.updatedAt
				? 1
				: -1,
	);
	const facets: Record<string, unknown> = {};
	let dropped = 0;
	const keys = uniqueSorted(members.flatMap((m) => Object.keys(m.facets)));
	for (const key of keys) {
		const values = latestFirst
			.map((m) => m.facets[key])
			.filter((v) => v !== undefined);
		const value = values.every(Array.isArray)
			? uniqueSorted(
					(values as unknown[][])
						.flat()
						.filter((x): x is string => typeof x === "string"),
				)
			: values[0];
		if (Array.isArray(value)) {
			const kept = (value as string[]).filter(
				(v) => lintFacets({ [key]: v }, repoTerms).length === 0,
			);
			dropped += value.length - kept.length;
			facets[key] = kept;
		} else if (lintFacets({ [key]: value }, repoTerms).length > 0) dropped++;
		else facets[key] = value;
	}
	return { facets, dropped };
}

export function majoritySpace(spaces: readonly Space[]): Space {
	const counts = new Map<Space, number>();
	for (const s of spaces) counts.set(s, (counts.get(s) ?? 0) + 1);
	const max = Math.max(...counts.values());
	const top = [...counts].filter(([, n]) => n === max).map(([s]) => s);
	return top.includes("coding") ? "coding" : top.sort()[0]!;
}

export function provenanceOf(
	members: readonly KnowledgeRow[],
): ProvenanceStatus {
	if (members.some((m) => m.provenanceStatus === "resolved")) return "resolved";
	if (members.some((m) => m.provenanceStatus === "external")) return "external";
	return "source_missing";
}

export function confidenceOf(members: readonly KnowledgeRow[]): number {
	const base = Math.min(
		0.95,
		Math.max(...members.map((m) => m.confidence)) +
			0.05 * Math.log2(members.length),
	);
	return members.every((m) => m.provenanceStatus === "source_missing")
		? Math.min(0.6, base)
		: base;
}

/** The old canonical (active) whose derived-from atoms share at least half with the new members. */
function findReusable(
	db: Database,
	memberIds: readonly string[],
	claimed: ReadonlySet<string>,
): { row: KnowledgeRow; derived: Set<string> } | null {
	const seen = new Set<string>();
	let best: { row: KnowledgeRow; derived: Set<string>; score: number } | null =
		null;
	const members = new Set(memberIds);
	for (const atomId of memberIds)
		for (const canonicalId of listSupersededBy(db, atomId)) {
			if (seen.has(canonicalId) || claimed.has(canonicalId)) continue;
			seen.add(canonicalId);
			const row = getKnowledgeById(db, canonicalId);
			if (!row || row.layer !== "canonical" || row.status !== "active")
				continue;
			const derived = new Set(
				listKnowledgeEvidence(db, canonicalId)
					.filter((e) => e.targetKind === "atom" && e.role === "derived_from")
					.map((e) => e.targetId!)
					.filter(Boolean),
			);
			const inter = [...derived].filter((d) => members.has(d)).length;
			const union = new Set([...derived, ...members]).size;
			const score = union === 0 ? 0 : inter / union;
			if (score >= JACCARD_REUSE && (!best || score > best.score))
				best = { row, derived, score };
		}
	return best;
}

export function writeCanonical(
	db: Database,
	input: UnitInput,
	group: Extract<GroupResult, { kind: "canonical" }>,
	atoms: readonly AtomView[],
	claimed: Set<string>,
	at: string,
): { id: string; digest: string; handle: string; reused: boolean } {
	const rows = atoms.map((a) => a.row);
	const memberIds = rows.map((r) => r.id);
	const reusable = findReusable(db, memberIds, claimed);
	const id = reusable?.row.id ?? randomUUID();
	claimed.add(id);
	const draft = group.draft;
	const existing = reusable?.row ?? null;

	const merged = mergeFacets(rows, input.repoTerms);
	const used = atoms.reduce((n, a) => n + a.used, 0);
	const notUsed = atoms.reduce((n, a) => n + a.notUsed, 0);
	upsertKnowledgeItem(db, {
		id,
		layer: "canonical",
		type: draft.type,
		polarity: draft.polarity,
		title: draft.title,
		body: draft.guidance,
		situation: draft.situation,
		rationale: draft.rationale,
		exceptions: draft.exceptions,
		examples: existing?.examples ?? [],
		appliesWhen: draft.appliesWhen,
		notAppliesWhen: draft.notAppliesWhen,
		steps: draft.steps,
		facets: merged.facets,
		confidence: confidenceOf(rows),
		importance: Math.max(...rows.map((r) => r.importance)),
		status: "active",
		space: majoritySpace(rows.map((r) => r.space)),
		scope: "global",
		repoKey: null,
		validFrom: existing?.validFrom ?? null,
		validUntil: existing?.validUntil ?? null,
		provenanceStatus: provenanceOf(rows),
		metadata: {
			...existing?.metadata,
			distill: {
				clusterId: input.clusterId,
				promptVersion: CANONICAL_PROMPT_VERSION,
				plannerCallId: group.plannerCallId,
				verifierCallId: group.verifierCallId,
			},
			usage: { used, notUsed },
		},
		createdAt: existing?.createdAt ?? at,
		updatedAt: at,
	});

	// Evidence: every member, with the claims it supports; earlier derivations are kept.
	const evidence: EvidenceInput[] = atoms.map((atom) => {
		const quote = draft.claims
			.filter((c) => c.support.includes(atom.alias))
			.map((c) => c.text)
			.join(" ")
			.slice(0, 1000);
		return {
			targetKind: "atom",
			targetId: atom.row.id,
			externalRef: null,
			role: "derived_from",
			quote: quote === "" ? null : quote,
			confidence: null,
		};
	});
	if (existing) {
		const have = new Set(memberIds);
		for (const old of listKnowledgeEvidence(db, id))
			if (
				old.origin === "pipeline" &&
				old.targetKind === "atom" &&
				old.role === "derived_from" &&
				old.targetId &&
				!have.has(old.targetId)
			)
				evidence.push({
					targetKind: "atom",
					targetId: old.targetId,
					externalRef: null,
					role: "derived_from",
					quote: old.quote,
					confidence: old.confidence,
				});
	}
	replaceKnowledgeEvidence(db, id, "pipeline", evidence, at);

	const row = getKnowledgeById(db, id)!;
	for (const atom of atoms) {
		upsertEdge(db, {
			src: { kind: "knowledge", id },
			relation: "supersedes",
			dst: { kind: "knowledge", id: atom.row.id },
			origin: "llm",
			status: "active",
			confidence: row.confidence,
			evidence: {
				clusterId: input.clusterId,
				plannerCallId: group.plannerCallId,
				verifierCallId: group.verifierCallId,
			},
			extractorVersion: CANONICAL_PROMPT_VERSION,
			at,
		});
		setKnowledgeDisposition(db, atom.row.id, {
			status: "superseded",
			retrieval: "evidence_only",
			updatedAt: at,
		});
	}
	return {
		id,
		digest: knowledgeContentDigest(row.title, row.body, row.situation),
		handle: row.handle,
		reused: existing !== null,
	};
}

/** conflict -> a judgment and a `distill.resolve` job; condition_split -> a judgment, both kept. */
function writeRelations(
	db: Database,
	deps: DistillDeps,
	input: UnitInput,
	result: UnitResult,
	adopted: ReadonlyMap<number, { id: string; digest: string }>,
	counts: Counts,
	at: string,
): void {
	for (const rel of result.relations) {
		const a = adopted.get(rel.a);
		const b = adopted.get(rel.b);
		if (!a || !b || a.id === b.id) {
			bump(counts, "relationsSkipped");
			continue;
		}
		const [first, second] = a.id < b.id ? [a, b] : [b, a];
		const before = getPairJudgment(db, a.id, b.id);
		if (
			before &&
			before.aDigest === first.digest &&
			before.bDigest === second.digest
		) {
			bump(counts, "relationsSkipped");
			continue;
		}
		upsertPairJudgment(db, {
			aId: first.id,
			bId: second.id,
			aDigest: first.digest,
			bDigest: second.digest,
			verdict: rel.kind,
			resolution: rel.kind === "condition_split" ? "split" : "none",
			detail: {
				origin: "canonical_planner",
				note: rel.note,
				runId: input.runId,
			},
			callId: null,
			at,
		});
		bump(counts, rel.kind === "conflict" ? "conflicts" : "splits");
		if (rel.kind !== "conflict") continue;
		try {
			deps.queue.enqueueInTransaction(db, {
				scope: "distill",
				kind: "distill.resolve",
				dedupeKey: `resolve:${first.id}:${second.id}:${first.digest}:${second.digest}:${input.runId}`,
				payload: { runId: input.runId, a: first.id, b: second.id },
				subjectRef: `${first.id}:${second.id}`,
				lane: "background",
				maxAttempts: 3,
			});
		} catch (error) {
			// A full queue defers the resolution: the judgment stays unresolved for the conflict stage.
			if (error instanceof Error && error.message === "queue_full")
				bump(counts, "resolveDeferred");
			else throw error;
		}
	}
}
