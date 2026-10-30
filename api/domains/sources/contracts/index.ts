import type { Scope, Space } from "../../../infrastructure/scope";

export type SourceKind = "agent_log" | "document" | "web" | "research";

export interface SourceRecordInput {
	id: string;
	kind: SourceKind;
	uri: string;
	title: string | null;
	content: string;
	space: Space;
	scope: Scope;
	repoKey: string | null;
	recordedAt: string;
	metadata: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
}

export interface SourceFragmentInput {
	id: string;
	sourceId: string;
	locator: string;
	byteStart: number | null;
	byteEnd: number | null;
	heading: string | null;
	content: string;
	createdAt: string;
}

export interface SourceRecordRow {
	id: string;
	kind: SourceKind;
	uri: string;
	title: string | null;
	content: string;
	space: Space;
	scope: Scope;
	repoKey: string | null;
	recordedAt: string;
}

export interface SourceFragmentRow {
	id: string;
	sourceId: string;
	locator: string;
	heading: string | null;
	content: string;
}
