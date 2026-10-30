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

export interface KnowledgeInput {
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

export interface KnowledgeRow extends Omit<KnowledgeInput, "metadata"> {
	handle: string;
	revision: number;
	contentDigest: string;
	metadata: Record<string, unknown>;
}

export interface EvidenceRow extends EvidenceInput {
	id: string;
	origin: EvidenceOrigin;
}
