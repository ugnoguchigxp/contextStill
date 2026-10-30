import { z } from "zod";
import type { KnowledgeRow } from "../../../knowledge";
import type {
	CanonicalDraft,
	Generality,
	ReviewKind,
	VerifierOutput,
} from "../../contracts";

/** One job: a claim cluster, or up to 8 atoms that belong to no cluster (6.4). */
export const canonicalPayload = z.union([
	z.strictObject({
		runId: z.string().min(1),
		clusterId: z.string().min(1),
		memberDigest: z.string().min(1),
	}),
	z.strictObject({
		runId: z.string().min(1),
		singles: z.array(z.string().min(1)).min(1).max(8),
	}),
]);
export type CanonicalPayload = z.infer<typeof canonicalPayload>;

export const embedPayload = z.strictObject({ runId: z.string().min(1) });
export type EmbedPayload = z.infer<typeof embedPayload>;

/** An atom as the job holds it: the row read in the prepare step and its local alias. */
export interface AtomView {
	/** a1..aN, in id order. */
	alias: string;
	row: KnowledgeRow;
	generality: Generality | null;
	used: number;
	notUsed: number;
}

export interface UnitInput {
	runId: string;
	kind: "cluster" | "singles";
	clusterId: string | null;
	/** The cluster's member digest, or the digest of the singles' content digests. */
	memberDigest: string;
	/**
	 * A merge cluster (`conflict-merge-v1`) is made of atoms the old canonicals already absorbed:
	 * superseded atoms are accepted as members.
	 */
	merge: boolean;
	atoms: AtomView[];
	repoTerms: string[];
}

/** A host-side finding, kept as the check module reports it (kind and place only). */
export interface Violation {
	code: string;
	groupIndex: number | null;
	detail: string;
}

export interface VerifierSummary {
	verdict: VerifierOutput["verdict"];
	rationale: string;
	failedClaims: number[];
	failedChecks: string[];
}

/** What a group of the planner became after the host checks and the verifier. */
export type GroupResult =
	| {
			kind: "canonical";
			/** Aliases of the members. */
			members: string[];
			draft: CanonicalDraft;
			plannerCallId: string;
			verifierCallId: string;
			/** The majority polarity was a tie: adopted, and the owner is asked to look. */
			polarityTie: boolean;
			/** Index of the group in the planner's answer, for the relations. */
			index: number;
	  }
	| {
			kind: "disposition";
			members: string[];
			disposition: "repo_specific" | "unusable";
			plannerCallId: string;
			index: number;
	  }
	| {
			kind: "review";
			review: Extract<ReviewKind, "host_rejected" | "verifier_unknown">;
			members: string[];
			draft: CanonicalDraft | null;
			violations: Violation[];
			verifier: VerifierSummary | null;
			reason: string;
			plannerCallId: string | null;
			verifierCallId: string | null;
			index: number | null;
	  };

export interface PlannedRelation {
	/** Indexes into the planner's groups. */
	a: number;
	b: number;
	kind: "condition_split" | "conflict";
	note: string;
}

export interface UnitResult {
	groups: GroupResult[];
	relations: PlannedRelation[];
	/** Relations the host dropped because an index did not name two groups. */
	relationsDropped: number;
}
