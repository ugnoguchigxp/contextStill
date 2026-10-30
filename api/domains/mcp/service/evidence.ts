import type { Database } from "bun:sqlite";
import { listEpisodeSources } from "../../experience";
import { listKnowledgeEvidence } from "../../knowledge";
import {
	getFragmentSourceId,
	getSourceContent,
	getSourceFragment,
	getSourceMeta,
	type SourceMetaRow,
} from "../../sources";

/**
 * An evidence link resolved to the source it points at; `external` carries no source.
 * It holds no text: the body is read only for the items that are published (see publicEvidence).
 */
export interface ResolvedEvidence {
	role: string;
	sourceKind: "agent_log" | "document" | "web" | "research" | "external";
	source: SourceMetaRow | null;
	/** The fragment the evidence points at, when it points at one. */
	fragmentId: string | null;
}

const EVIDENCE_LIMIT = 10;
const EXCERPT_CHARS = 600;

/** Cuts to at most `max` code points, scanning no further than the cut. */
export function cutChars(text: string, max: number): string {
	if (text.length <= max) return text;
	let count = 0;
	let index = 0;
	for (const ch of text) {
		if (count === max) break;
		count += 1;
		index += ch.length;
	}
	return text.slice(0, index);
}

/** Evidence of a knowledge item. Links to atoms and episodes are not source evidence and are left out. */
export function resolveKnowledgeEvidence(
	db: Database,
	knowledgeId: string,
): ResolvedEvidence[] {
	const out: ResolvedEvidence[] = [];
	for (const row of listKnowledgeEvidence(db, knowledgeId)) {
		if (row.targetKind === "external") {
			out.push({
				role: row.role,
				sourceKind: "external",
				source: null,
				fragmentId: null,
			});
		} else if (row.targetKind === "source" && row.targetId) {
			const source = getSourceMeta(db, row.targetId);
			if (source)
				out.push({
					role: row.role,
					sourceKind: source.kind,
					source,
					fragmentId: null,
				});
		} else if (row.targetKind === "fragment" && row.targetId) {
			const sourceId = getFragmentSourceId(db, row.targetId);
			const source = sourceId ? getSourceMeta(db, sourceId) : null;
			if (source)
				out.push({
					role: row.role,
					sourceKind: source.kind,
					source,
					fragmentId: row.targetId,
				});
		}
	}
	return out;
}

export function resolveEpisodeEvidence(
	db: Database,
	episodeId: string,
): ResolvedEvidence[] {
	const out: ResolvedEvidence[] = [];
	for (const ref of listEpisodeSources(db, episodeId)) {
		const source = getSourceMeta(db, ref.sourceId);
		if (source)
			out.push({
				role: ref.role,
				sourceKind: source.kind,
				source,
				fragmentId: null,
			});
	}
	return out;
}

export function evidenceSummary(items: readonly ResolvedEvidence[]) {
	return {
		count: items.length,
		sourceKinds: [...new Set(items.map((i) => i.sourceKind))].sort(),
	};
}

/** The URL to show for a source URI: http(s) only, without credentials, query or fragment. */
export function publicUrl(uri: string): string | null {
	let url: URL;
	try {
		url = new URL(uri);
	} catch {
		return null;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return null;
	url.username = "";
	url.password = "";
	url.search = "";
	url.hash = "";
	return url.href;
}

/**
 * The public form of one evidence item. Only document / web / research sources that are global
 * and outside the personal space show a title and excerpt; the URL is shown for http(s) URIs.
 * Conversation logs and external references give only their role and kind. The source or fragment
 * text is read here, so call this only for items that are published.
 */
export function publicEvidence(
	db: Database,
	item: ResolvedEvidence,
): Record<string, unknown> {
	const { source } = item;
	const open =
		source !== null &&
		(source.kind === "document" ||
			source.kind === "web" ||
			source.kind === "research") &&
		source.scope === "global" &&
		source.space !== "personal";
	if (!open) return { role: item.role, sourceKind: item.sourceKind };
	const text =
		item.fragmentId !== null
			? (getSourceFragment(db, item.fragmentId)?.content ?? "")
			: (getSourceContent(db, source.id) ?? "");
	return {
		role: item.role,
		sourceKind: item.sourceKind,
		title: source.title,
		url: publicUrl(source.uri),
		excerpt: cutChars(text.trim(), EXCERPT_CHARS),
	};
}

export type PublicEvidenceList = ReturnType<typeof publicEvidenceList>;

/** The published evidence: the first EVIDENCE_LIMIT items only are read for their text. */
export function publicEvidenceList(
	db: Database,
	items: readonly ResolvedEvidence[],
) {
	return {
		evidence: items.slice(0, EVIDENCE_LIMIT).map((i) => publicEvidence(db, i)),
		truncated: items.length > EVIDENCE_LIMIT,
	};
}
