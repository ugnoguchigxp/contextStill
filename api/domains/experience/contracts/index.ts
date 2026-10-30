import type { Scope, Space } from "../../../infrastructure/scope";

export type OutcomeKind = "success" | "failure" | "mixed" | "unknown";
export type EpisodeStatus = "active" | "stale" | "retracted";
export type TimePrecision = "exact" | "minute" | "day" | "month" | "unknown";

export interface EpisodeInput {
	id: string;
	title: string;
	situation: string;
	intent: string;
	decision: string;
	observations: string;
	action: string;
	outcome: string;
	lesson: string;
	openQuestions: string[];
	outcomeKind: OutcomeKind;
	eventStart: string | null;
	eventEnd: string | null;
	timePrecision: TimePrecision;
	confidence: number;
	importance: number;
	status: EpisodeStatus;
	space: Space;
	scope: Scope;
	repoKey: string | null;
	facets: Record<string, unknown>;
	metadata: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
}

export interface EpisodeRow extends Omit<EpisodeInput, "metadata"> {
	handle: string;
	revision: number;
}

export interface EpisodeSourceRef {
	sourceId: string;
	locator: string;
	role: "derived_from" | "supports";
}
