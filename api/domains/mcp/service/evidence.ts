import type { Database } from "bun:sqlite";
import { listEpisodeSources } from "../../experience";
import { listKnowledgeEvidence } from "../../knowledge";
import {
	getFragmentSourceId,
	getFragmentExcerpt,
	getSourceExcerpt,
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

/**
 * Evidence of a knowledge item. Links to episodes are not source evidence and are left out.
 * A link to an atom is followed one level: the originals the atom stands on count as the item's
 * own, so a canonical item shows the records behind its atoms. The same original (a source, a
 * fragment or an external reference) appears once, in the order first met.
 */
export function resolveKnowledgeEvidence(
	db: Database,
	knowledgeId: string,
): ResolvedEvidence[] {
	const out: ResolvedEvidence[] = [];
	const seen = new Set<string>();
	const add = (item: ResolvedEvidence, key: string) => {
		if (seen.has(key)) return;
		seen.add(key);
		out.push(item);
	};
	const collect = (id: string, followAtoms: boolean) => {
		for (const row of listKnowledgeEvidence(db, id)) {
			if (row.targetKind === "external") {
				add(
					{
						role: row.role,
						sourceKind: "external",
						source: null,
						fragmentId: null,
					},
					`external:${row.externalRef ?? ""}`,
				);
			} else if (row.targetKind === "source" && row.targetId) {
				const source = getSourceMeta(db, row.targetId);
				if (source)
					add(
						{
							role: row.role,
							sourceKind: source.kind,
							source,
							fragmentId: null,
						},
						`source:${source.id}`,
					);
			} else if (row.targetKind === "fragment" && row.targetId) {
				const sourceId = getFragmentSourceId(db, row.targetId);
				const source = sourceId ? getSourceMeta(db, sourceId) : null;
				if (source)
					add(
						{
							role: row.role,
							sourceKind: source.kind,
							source,
							fragmentId: row.targetId,
						},
						`fragment:${row.targetId}`,
					);
			} else if (followAtoms && row.targetKind === "atom" && row.targetId) {
				collect(row.targetId, false);
			}
		}
	};
	collect(knowledgeId, true);
	return out;
}

/** How many distinct atoms the item stands on (links that refute are not support). */
export function countSupportingAtoms(
	db: Database,
	knowledgeId: string,
): number {
	const atoms = new Set<string>();
	for (const row of listKnowledgeEvidence(db, knowledgeId))
		if (row.targetKind === "atom" && row.targetId && row.role !== "refutes")
			atoms.add(row.targetId);
	return atoms.size;
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
	// Only the head is read: leading blanks are trimmed, so twice the excerpt is taken.
	const head =
		item.fragmentId !== null
			? getFragmentExcerpt(db, item.fragmentId, EXCERPT_CHARS * 2)
			: getSourceExcerpt(db, source.id, EXCERPT_CHARS * 2);
	const text = head ?? "";
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
