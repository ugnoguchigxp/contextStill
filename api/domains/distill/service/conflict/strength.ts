import type { Database } from "bun:sqlite";
import { getKnowledgeById, listKnowledgeEvidence } from "../../../knowledge";
import { usedCount } from "./reads";

/** The strength coefficients of 6.5. Initial values; the pilot may revise them. */
export const STRENGTH = {
	/** Both sides must differ by at least this much for an automatic decision. */
	minGap: 1.0,
	/** An importance at or above this value always goes to the owner. */
	importanceCeiling: 0.8,
	/** The newest evidence must be this much newer to earn the recency point. */
	recencyMs: 90 * 86_400_000,
	usedWeight: 0.5,
} as const;

/** What the strength of one canonical is made of. */
export interface StrengthInputs {
	/** Atoms the canonical was distilled from (every status). */
	atoms: number;
	/** Distinct raw records behind those atoms; source_missing atoms add none. */
	records: number;
	/** `used` reports on the canonical and on its atoms. */
	used: number;
	/** Newest `created_at` among the atoms; null when it has none. */
	latest: string | null;
	importance: number;
}

export interface StrengthScore {
	score: number;
	/** 1 when this side's newest evidence is at least `recencyMs` newer than the other's, else 0. */
	recency: 0 | 1;
}

const RECORD_KINDS: ReadonlySet<string> = new Set([
	"source",
	"fragment",
	"episode",
]);

/** The atoms a canonical was derived from, in the order of its evidence. */
export function canonicalAtomIds(db: Database, canonicalId: string): string[] {
	const ids: string[] = [];
	for (const e of listKnowledgeEvidence(db, canonicalId))
		if (
			e.targetKind === "atom" &&
			e.role === "derived_from" &&
			e.targetId !== null &&
			!ids.includes(e.targetId)
		)
			ids.push(e.targetId);
	return ids;
}

/** Reads the inputs of the strength of a canonical (6.5). */
export function gatherStrength(
	db: Database,
	canonicalId: string,
): StrengthInputs {
	const canonical = getKnowledgeById(db, canonicalId);
	const atomIds = canonicalAtomIds(db, canonicalId);
	const records = new Set<string>();
	let atoms = 0;
	let latest: string | null = null;
	for (const id of atomIds) {
		const atom = getKnowledgeById(db, id);
		if (!atom) continue;
		atoms++;
		if (latest === null || atom.createdAt > latest) latest = atom.createdAt;
		if (atom.provenanceStatus === "source_missing") continue;
		for (const e of listKnowledgeEvidence(db, id))
			if (RECORD_KINDS.has(e.targetKind) && e.targetId !== null)
				records.add(`${e.targetKind}:${e.targetId}`);
	}
	return {
		atoms,
		records: records.size,
		used: usedCount(db, [canonicalId, ...atomIds]),
		latest,
		importance: canonical?.importance ?? 0,
	};
}

/** S = log2(1+atoms) + log2(1+records) + 0.5·log2(1+used) + R. */
export function strengthScore(
	self: StrengthInputs,
	other: StrengthInputs,
): StrengthScore {
	const newer =
		self.latest !== null &&
		other.latest !== null &&
		Date.parse(self.latest) - Date.parse(other.latest) >= STRENGTH.recencyMs;
	const recency = newer ? 1 : 0;
	return {
		score:
			Math.log2(1 + self.atoms) +
			Math.log2(1 + self.records) +
			STRENGTH.usedWeight * Math.log2(1 + self.used) +
			recency,
		recency,
	};
}

export interface ConflictDecision {
	a: StrengthScore;
	b: StrengthScore;
	/** The side that wins automatically, or null when the owner decides. */
	winner: "a" | "b" | null;
	/** Why the owner decides. */
	reason: "close" | "importance" | null;
}

/** The automatic rule of 6.5: a gap of 1.0 or more and both importances below 0.8. */
export function decideConflict(
	a: StrengthInputs,
	b: StrengthInputs,
): ConflictDecision {
	const sa = strengthScore(a, b);
	const sb = strengthScore(b, a);
	const gap = Math.abs(sa.score - sb.score);
	if (
		a.importance >= STRENGTH.importanceCeiling ||
		b.importance >= STRENGTH.importanceCeiling
	)
		return { a: sa, b: sb, winner: null, reason: "importance" };
	// A small epsilon keeps a gap of exactly 1.0 (e.g. 3 atoms against 1) on the automatic side.
	if (gap + 1e-9 < STRENGTH.minGap)
		return { a: sa, b: sb, winner: null, reason: "close" };
	return {
		a: sa,
		b: sb,
		winner: sa.score > sb.score ? "a" : "b",
		reason: null,
	};
}
