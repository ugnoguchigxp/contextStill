import type { Scope, Space } from "../../../infrastructure/scope";

export type KnowledgeLayer = "atom" | "canonical";
export type KnowledgeType = "rule" | "procedure";
export type Polarity = "positive" | "negative";
export type KnowledgeStatus =
	| "candidate"
	| "active"
	| "superseded"
	| "retracted";
export type ProvenanceStatus =
	| "resolved"
	| "external"
	| "source_missing"
	| "unresolved";

/** Whether search may return the row. The upsert never writes it; `setKnowledgeDisposition` does. */
export type Retrieval = "searchable" | "evidence_only";

export interface CanonicalExample {
	situation: string;
	action: string;
	outcome: string;
	episodeIds: string[];
}

/** The fields of a canonical item. Atoms keep the defaults ('' and []). */
export interface CanonicalFields {
	/** 1..600 characters; required for a canonical, '' for an atom. */
	situation: string;
	/** 0..800 characters. */
	rationale: string;
	/** At most 8, each at most 200 characters. */
	exceptions: string[];
	/** At most 2 (N2b). */
	examples: CanonicalExample[];
}

export interface KnowledgeInput extends Partial<CanonicalFields> {
	id: string;
	layer: KnowledgeLayer;
	type: KnowledgeType;
	polarity: Polarity;
	title: string;
	body: string;
	appliesWhen: string[];
	notAppliesWhen: string[];
	steps: string[];
	facets: Record<string, unknown>;
	confidence: number;
	importance: number;
	status: KnowledgeStatus;
	space: Space;
	scope: Scope;
	repoKey: string | null;
	validFrom: string | null;
	validUntil: string | null;
	provenanceStatus: ProvenanceStatus;
	metadata: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
}

export type EvidenceTargetKind =
	| "atom"
	| "source"
	| "fragment"
	| "episode"
	| "external";
export type EvidenceRole = "derived_from" | "supports" | "refutes";
export type EvidenceOrigin = "legacy_import" | "pipeline" | "human";

export interface EvidenceInput {
	targetKind: EvidenceTargetKind;
	targetId: string | null;
	externalRef: string | null;
	role: EvidenceRole;
	quote: string | null;
	confidence: number | null;
}

export interface KnowledgeRow
	extends
		Omit<KnowledgeInput, "metadata" | keyof CanonicalFields>,
		CanonicalFields {
	handle: string;
	retrieval: Retrieval;
	revision: number;
	contentDigest: string;
	metadata: Record<string, unknown>;
}

export interface EvidenceRow extends EvidenceInput {
	id: string;
	origin: EvidenceOrigin;
}
