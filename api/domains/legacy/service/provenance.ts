import type { Database } from "bun:sqlite";
import type { EvidenceInput, ProvenanceStatus } from "../../knowledge";
import { isRecord } from "./convert";

interface QueueEntry {
	kind: string;
	key: string;
	uri: string;
}
interface SourceLink {
	fragmentId: string;
	confidence: number;
}
interface OriginLink {
	kind: string;
	key: string;
	uri: string;
}

/** What the importer needs from the snapshot to trace a knowledge item back to its source. */
export interface ProvenanceIndex {
	vibeIds: Set<string>;
	sources: { id: string; uri: string }[];
	sourceIdByUri: Map<string, string>;
	candidateJob: Map<string, string>;
	queue: Map<string, QueueEntry>;
	sourceLinks: Map<string, SourceLink[]>;
	originLinks: Map<string, OriginLink[]>;
}

export interface ResolvedProvenance {
	status: ProvenanceStatus;
	/** Which step found the origin (`found_candidate:<kind>`, `target_metadata:<kind>`, …). */
	origin: string;
	evidence: EvidenceInput[];
}

function pushTo<T>(map: Map<string, T[]>, key: string, value: T) {
	const list = map.get(key);
	if (list) list.push(value);
	else map.set(key, [value]);
}

export function loadProvenanceIndex(db: Database): ProvenanceIndex {
	const index: ProvenanceIndex = {
		vibeIds: new Set(),
		sources: [],
		sourceIdByUri: new Map(),
		candidateJob: new Map(),
		queue: new Map(),
		sourceLinks: new Map(),
		originLinks: new Map(),
	};
	for (const row of db
		.query("SELECT id FROM vibe_memories")
		.iterate() as Iterable<{
		id: string;
	}>)
		index.vibeIds.add(row.id);
	for (const row of db
		.query("SELECT id, uri FROM sources ORDER BY id")
		.all() as { id: string; uri: string }[]) {
		index.sources.push(row);
		index.sourceIdByUri.set(row.uri, row.id);
	}
	for (const row of db
		.query("SELECT id, finding_job_id FROM found_candidates")
		.iterate() as Iterable<{ id: string; finding_job_id: string }>)
		index.candidateJob.set(row.id, row.finding_job_id);
	for (const row of db
		.query(
			"SELECT id, source_kind, source_key, source_uri FROM finding_candidate_queue",
		)
		.iterate() as Iterable<{
		id: string;
		source_kind: string;
		source_key: string;
		source_uri: string;
	}>)
		index.queue.set(row.id, {
			kind: row.source_kind,
			key: row.source_key,
			uri: row.source_uri,
		});
	for (const row of db
		.query(
			`SELECT knowledge_id, source_fragment_id, confidence FROM knowledge_source_links
			 ORDER BY created_at, id`,
		)
		.all() as {
		knowledge_id: string;
		source_fragment_id: string;
		confidence: number;
	}[])
		pushTo(index.sourceLinks, row.knowledge_id, {
			fragmentId: row.source_fragment_id,
			confidence: row.confidence,
		});
	for (const row of db
		.query(
			`SELECT knowledge_id, origin_kind, origin_key, origin_uri FROM knowledge_origin_links
			 ORDER BY created_at, id`,
		)
		.all() as {
		knowledge_id: string;
		origin_kind: string;
		origin_key: string;
		origin_uri: string;
	}[])
		pushTo(index.originLinks, row.knowledge_id, {
			kind: row.origin_kind,
			key: row.origin_key,
			uri: row.origin_uri,
		});
	return index;
}

const FIXED_TARGET_KEY = "the source target";
const ORIGIN_LINK_KINDS: Record<string, string> = {
	vibe_memory: "vibe_memory",
	agent_candidate: "knowledge_candidate",
};

const sourceEvidence = (id: string): EvidenceInput => ({
	targetKind: "source",
	targetId: id,
	externalRef: null,
	role: "derived_from",
	quote: null,
	confidence: null,
});
const externalEvidence = (ref: string): EvidenceInput => ({
	targetKind: "external",
	targetId: null,
	externalRef: ref,
	role: "derived_from",
	quote: null,
	confidence: null,
});

/**
 * A wiki page is found by its full URI when the entry has one (the same page name in another
 * repo's wiki must not match). Only an entry without a URI falls back to the key: an exact
 * URI, else a wiki-relative key (`TechKnowledge/x.md`) when exactly one page ends with it.
 */
function findWikiSource(
	index: ProvenanceIndex,
	entry: QueueEntry,
): { id: string } | undefined {
	if (entry.uri !== "") return index.sources.find((s) => s.uri === entry.uri);
	const exact = index.sources.find((s) => s.uri === entry.key);
	if (exact) return exact;
	const named = index.sources.filter((s) =>
		s.uri.endsWith(`/wiki/pages/${entry.key}`),
	);
	return named.length === 1 ? named[0] : undefined;
}

/** The per-kind resolution table; null when the kind is not one of the four known ones. */
function resolveKind(
	index: ProvenanceIndex,
	entry: QueueEntry,
): { status: ProvenanceStatus; evidence: EvidenceInput } | null {
	switch (entry.kind) {
		case "vibe_memory":
			return index.vibeIds.has(entry.key)
				? { status: "resolved", evidence: sourceEvidence(entry.key) }
				: {
						status: "source_missing",
						evidence: externalEvidence(`vibe_memory:${entry.key}`),
					};
		case "wiki_file": {
			const found = findWikiSource(index, entry);
			return found
				? { status: "resolved", evidence: sourceEvidence(found.id) }
				: {
						status: "source_missing",
						evidence: externalEvidence(`wiki:${entry.key}`),
					};
		}
		case "web_ingest": {
			const uri = entry.uri !== "" ? entry.uri : entry.key;
			const id = index.sourceIdByUri.get(uri);
			return id
				? { status: "resolved", evidence: sourceEvidence(id) }
				: { status: "external", evidence: externalEvidence(uri) };
		}
		case "knowledge_candidate":
			return {
				status: "external",
				evidence: externalEvidence(`agent_candidate:${entry.key}`),
			};
		default:
			return null;
	}
}

function chainEntry(
	index: ProvenanceIndex,
	metadata: Record<string, unknown>,
): QueueEntry | null {
	const candidateId = metadata.foundCandidateId;
	if (typeof candidateId !== "string") return null;
	const job = index.candidateJob.get(candidateId);
	return job ? (index.queue.get(job) ?? null) : null;
}

function targetEntry(metadata: Record<string, unknown>): QueueEntry | null {
	const kind = metadata.targetKind;
	const key = metadata.targetKey;
	if (typeof kind !== "string" || typeof key !== "string") return null;
	if (key === "" || key === FIXED_TARGET_KEY) return null;
	const document = metadata.sourceDocumentUri;
	return {
		kind,
		key,
		uri:
			kind === "web_ingest"
				? key
				: typeof document === "string"
					? document
					: "",
	};
}

/**
 * The first origin found, in order: the found-candidate chain, the target recorded in the
 * metadata, the origin links. Fragment links are always added as extra evidence. Every item
 * is `unresolved` when nothing is found and no fragment is linked.
 */
export function resolveProvenance(
	index: ProvenanceIndex,
	knowledgeId: string,
	rawMetadata: unknown,
): ResolvedProvenance {
	const metadata = isRecord(rawMetadata) ? rawMetadata : {};
	const candidates: { step: string; entry: QueueEntry }[] = [];
	const chain = chainEntry(index, metadata);
	if (chain) candidates.push({ step: "found_candidate", entry: chain });
	const target = targetEntry(metadata);
	if (target) candidates.push({ step: "target_metadata", entry: target });
	for (const link of index.originLinks.get(knowledgeId) ?? []) {
		const kind = ORIGIN_LINK_KINDS[link.kind];
		if (kind)
			candidates.push({
				step: "origin_link",
				entry: { kind, key: link.key, uri: link.uri },
			});
	}
	let status: ProvenanceStatus = "unresolved";
	let origin = "none";
	const evidence: EvidenceInput[] = [];
	for (const { step, entry } of candidates) {
		const resolved = resolveKind(index, entry);
		if (!resolved) continue;
		status = resolved.status;
		origin = `${step}:${entry.kind}`;
		evidence.push(resolved.evidence);
		break;
	}
	for (const link of index.sourceLinks.get(knowledgeId) ?? [])
		evidence.push({
			targetKind: "fragment",
			targetId: link.fragmentId,
			externalRef: null,
			role: "derived_from",
			quote: null,
			confidence: Math.min(1, Math.max(0, link.confidence)),
		});
	// A linked fragment is a real source even when no origin could be traced.
	if (status === "unresolved" && evidence.length > 0) {
		status = "resolved";
		origin = "source_link";
	}
	return { status, origin, evidence };
}
