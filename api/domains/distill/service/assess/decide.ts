import {
	hasConcreteSignals,
	repoSignals,
	type RepoSignals,
	type TermSet,
} from "../checks";
import type { Generality } from "../../contracts";

const MAX_LISTED = 5;

export interface LegacyInfo {
	scope: string | null;
	classificationStatus: string | null;
	repoKey: string | null;
}

/** What the legacy import kept of the old scope (`metadata.legacy`). */
export function legacyInfo(metadataJson: string): LegacyInfo {
	let legacy: Record<string, unknown> = {};
	try {
		const parsed = JSON.parse(metadataJson) as { legacy?: unknown };
		if (parsed.legacy && typeof parsed.legacy === "object")
			legacy = parsed.legacy as Record<string, unknown>;
	} catch {
		/* a row without readable metadata has no legacy hints */
	}
	const text = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
	return {
		scope: text(legacy.scope),
		classificationStatus: text(legacy.classificationStatus),
		repoKey: text(legacy.repoKey),
	};
}

export interface Signals {
	found: RepoSignals;
	/** What is stored in `signals_json`. */
	stored: Record<string, unknown>;
}

/** The deterministic signs (a)-(e) of 6.1 for one row. */
export function assessSignals(
	text: string,
	repoTerms: TermSet,
	row: { scope: string; repoKey: string | null },
	legacy: LegacyInfo,
): Signals {
	const found = repoSignals(text, repoTerms);
	return {
		found,
		stored: {
			repoTerms: found.repoTerms.slice(0, MAX_LISTED),
			absolutePaths: found.absolutePaths.slice(0, MAX_LISTED),
			relativePaths: found.relativePaths.slice(0, MAX_LISTED),
			ports: found.ports.slice(0, MAX_LISTED),
			scope: row.scope,
			repoKey: row.repoKey,
			legacy,
		},
	};
}

/**
 * The decision of 6.1: the model's verdict, except that `general` with a path or a port in the
 * text becomes `generalizable` (the canonical stage must take the specifics out).
 */
export function decideGenerality(
	verdict: Generality,
	signals: RepoSignals,
): { generality: Generality; downgraded: boolean } {
	if (verdict === "general" && hasConcreteSignals(signals))
		return { generality: "generalizable", downgraded: true };
	return { generality: verdict, downgraded: false };
}

/** repo_specific and unusable rows are kept as evidence and no longer searched. */
export const isEvidenceOnly = (g: Generality): boolean =>
	g === "repo_specific" || g === "unusable";
