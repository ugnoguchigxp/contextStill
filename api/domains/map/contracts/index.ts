export type ClusterKind = "claim" | "theme";
export type ClusterState =
	| "pending"
	| "distilled"
	| "review"
	| "rejected"
	| "stale";
export type NodeKind = "knowledge" | "episode" | "theme";
export type Relation =
	| "about"
	| "broader"
	| "requires"
	| "supports"
	| "refines"
	| "contradicts"
	| "supersedes"
	| "example_of"
	| "co_used";
export type EdgeOrigin =
	| "deterministic"
	| "clustering"
	| "llm"
	| "behavioral"
	| "human";
export type EdgeStatus = "candidate" | "active" | "retracted";
export type FacetKey = "domains" | "technologies" | "changeTypes";
export type FacetOrigin = "deterministic" | "llm" | "human";

export type MemberKind = "knowledge" | "episode";
export interface ClusterMember {
	kind: MemberKind;
	id: string;
	role: "member" | "core" | "example";
	similarity: number | null;
}

export interface ClusterInput {
	id: string;
	kind: ClusterKind;
	parentId: string | null;
	level: 0 | 1 | 2;
	name: string;
	aliases: string[];
	description: string;
	summary: Record<string, unknown>;
	state: ClusterState;
	algorithm: string;
	/** `memberDigest(members, contentDigests)`. Equal digests mean the membership did not change. */
	memberDigest: string;
	members: ClusterMember[];
	createdAt: string;
	updatedAt: string;
}

export interface ClusterRow extends Omit<ClusterInput, "members"> {
	/** `th_…` for a theme, null for a claim cluster. */
	handle: string | null;
	revision: number;
}

export interface EdgeInput {
	src: { kind: NodeKind; id: string };
	relation: Relation;
	dst: { kind: NodeKind; id: string };
	origin: EdgeOrigin;
	status: EdgeStatus;
	confidence: number;
	evidence: Record<string, unknown>;
	extractorVersion: string;
	at: string;
}

export interface EdgeRow extends Omit<EdgeInput, "at"> {
	id: string;
	createdAt: string;
	updatedAt: string;
}

export interface FacetConceptInput {
	facetKey: FacetKey;
	rawValue: string;
	concept: string;
	themeId: string | null;
	origin: FacetOrigin;
	at: string;
}

export interface FacetConceptRow {
	facetKey: FacetKey;
	rawValue: string;
	concept: string;
	themeId: string | null;
	origin: FacetOrigin;
	createdAt: string;
}
