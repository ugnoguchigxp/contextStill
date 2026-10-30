import type { Database } from "bun:sqlite";
import { canonicalJson, sha256Hex } from "../../../infrastructure/digest";
import { classifyTime, toUtcIso } from "../../../infrastructure/time";
import { l2norm } from "../../../infrastructure/vector";
import {
	type EpisodeInput,
	type EpisodeSourceRef,
	type EpisodeStatus,
	replaceEpisodeSources,
	upsertEpisode,
} from "../../experience";
import {
	type EvidenceInput,
	type KnowledgeInput,
	type KnowledgeRow as KnowledgeItem,
	type KnowledgeStatus,
	getKnowledgeById,
	knowledgeContentDigest,
	replaceKnowledgeEvidence,
	upsertKnowledgeItem,
} from "../../knowledge";
import {
	type SourceKind,
	upsertSourceFragment,
	upsertSourceRecord,
} from "../../sources";
import {
	type UsageActor,
	type UsageVerdict,
	insertUsageEvent,
} from "../../usage";
import { ensureVectorSpace, getVector, upsertVector } from "../../vectors";
import type { LegacyImportReport } from "../contracts";
import {
	isRecord,
	normalizeScope,
	parseArray,
	parseJson,
	parseObject,
	percentToUnit,
} from "./convert";
import { type ProvenanceIndex, resolveProvenance } from "./provenance";
import type { Planned } from "./runner";
import { LEGACY_VECTOR_SPACE } from "./vector-space";

/** Version of the conversion rules; it is part of every row digest, so a rule change re-imports. */
export const IMPORTER_VERSION = "legacy-import.v2" as const;
/** The rules that produced digests already stored in `legacy_import_map`. */
const PREVIOUS_VERSION = "legacy-import.v1";

/** Counters the planners fill while converting; the report is built from them. */
export interface ImportState {
	nowIso: string;
	time: LegacyImportReport["time"];
	provenance: LegacyImportReport["provenance"];
	vectors: LegacyImportReport["vectors"];
	draft: { total: number; gatePassed: number; gateFailed: number };
	/** `space_key` of the vector space legacy vectors are stored in. */
	spaceKey: string;
}

export function emptyState(nowIso: string, spaceKey: string): ImportState {
	return {
		nowIso,
		time: { converted: { iso: 0, sqlite: 0, unix_ms: 0 }, invalid: 0 },
		provenance: {
			resolved: 0,
			external: 0,
			source_missing: 0,
			unresolved: 0,
			byOrigin: {},
			activeUnresolved: 0,
		},
		vectors: { imported: 0, stale: 0, invalid: 0 },
		draft: { total: 0, gatePassed: 0, gateFailed: 0 },
		spaceKey,
	};
}

const digestOf = (legacy: unknown, version: string = IMPORTER_VERSION) =>
	sha256Hex(`${version}|${canonicalJson(legacy)}`);

/**
 * `created_at`: converted and counted by format; when it cannot be read it falls back to
 * `updated_at`, then to the import time (counted as invalid).
 */
function createdAtOf(
	state: ImportState,
	created: string | null,
	updated: string | null,
): string {
	if (created !== null) {
		const format = classifyTime(created);
		if (format !== "invalid") state.time.converted[format]++;
	}
	const own = toUtcIso(created);
	if (own) return own;
	state.time.invalid++;
	return toUtcIso(updated) ?? state.nowIso;
}

const updatedAtOf = (updated: string | null, createdAt: string) =>
	toUtcIso(updated) ?? createdAt;

// --- vibe_memories -> source_records (kind agent_log) ----------------------------------

export interface VibeRow {
	id: string;
	session_id: string;
	content: string;
	memory_type: string;
	dedupe_key: string | null;
	metadata: string;
	created_at: string;
	goal_id: string | null;
	parent_id: string | null;
	subject: string | null;
	intent: string | null;
	wants: string;
	refs: string;
	confidence: string | null;
	evidence_status: string | null;
	actor_id: string | null;
	ttl_at: string | null;
}
// `embedding` is deliberately not read: it is neither imported nor part of the digest.
export const VIBE_SQL = `SELECT id, session_id, content, memory_type, dedupe_key, metadata,
  created_at, goal_id, parent_id, subject, intent, wants, refs, confidence, evidence_status,
  actor_id, ttl_at FROM vibe_memories ORDER BY rowid`;

export const planVibe =
	(state: ImportState) =>
	(row: VibeRow): Planned => {
		const createdAt = createdAtOf(state, row.created_at, null);
		return {
			legacyId: row.id,
			digest: digestOf(row),
			targetTable: "source_records",
			targetId: row.id,
			apply: (db) =>
				upsertSourceRecord(db, {
					id: row.id,
					kind: "agent_log",
					uri: `vibe_memory:${row.id}`,
					title: row.subject,
					content: row.content,
					space: "coding",
					scope: "global",
					repoKey: null,
					recordedAt: createdAt,
					metadata: {
						legacy: {
							sessionId: row.session_id,
							memoryType: row.memory_type,
							metadata: parseJson<unknown>(row.metadata, row.metadata),
						},
					},
					createdAt,
					updatedAt: createdAt,
				}),
		};
	};

// --- sources / source_fragments ---------------------------------------------------------

export interface SourceRow {
	id: string;
	source_kind: string;
	uri: string;
	title: string | null;
	body: string;
	metadata: string;
	created_at: string;
	updated_at: string;
	last_indexed_at: string | null;
	classification_status: string;
	scope: string;
	project_ref: string | null;
	repo_key: string | null;
	repo_path: string | null;
}
export const SOURCES_SQL = `SELECT id, source_kind, uri, title, body, metadata, created_at,
  updated_at, last_indexed_at, classification_status, scope, project_ref, repo_key, repo_path
  FROM sources ORDER BY rowid`;

function sourceKindOf(legacy: string): SourceKind | null {
	if (legacy === "wiki") return "document";
	if (legacy.startsWith("web")) return "web";
	return null;
}

/** Whether `planSource` imports a source with this kind and scope (fragments follow it). */
export function sourceIsImportable(kind: string, scope: string): boolean {
	return (
		sourceKindOf(kind) !== null && (scope === "global" || scope === "repo")
	);
}

export const planSource =
	(state: ImportState) =>
	(row: SourceRow): Planned => {
		const kind = sourceKindOf(row.source_kind);
		if (!kind) return { skip: "unknown_source_kind" };
		const scope = normalizeScope(row.scope, row.repo_key, row.repo_path);
		if (!scope) return { skip: "unknown_scope" };
		const createdAt = createdAtOf(state, row.created_at, row.updated_at);
		const updatedAt = updatedAtOf(row.updated_at, createdAt);
		return {
			legacyId: row.id,
			digest: digestOf(row),
			targetTable: "source_records",
			targetId: row.id,
			apply: (db) =>
				upsertSourceRecord(db, {
					id: row.id,
					kind,
					uri: row.uri,
					title: row.title,
					content: row.body,
					space: "coding",
					scope: scope.scope,
					repoKey: scope.repoKey,
					recordedAt: createdAt,
					metadata: {
						legacy: {
							sourceKind: row.source_kind,
							scope: row.scope,
							classificationStatus: row.classification_status,
							projectRef: row.project_ref,
							repoKey: row.repo_key,
							repoPath: row.repo_path,
							lastIndexedAt: row.last_indexed_at,
							metadata: parseJson<unknown>(row.metadata, row.metadata),
						},
					},
					createdAt,
					updatedAt,
				}),
		};
	};

export interface FragmentRow {
	id: string;
	source_id: string;
	locator: string;
	heading: string | null;
	content: string;
	metadata: string;
	created_at: string;
}
export const FRAGMENTS_SQL = `SELECT id, source_id, locator, heading, content, metadata,
  created_at FROM source_fragments ORDER BY rowid`;

/** `importableSources`: ids of the sources the importer takes; others' fragments are skipped. */
export const planFragment =
	(state: ImportState, importableSources: ReadonlySet<string>) =>
	(row: FragmentRow): Planned => {
		if (!importableSources.has(row.source_id))
			return { skip: "source_skipped" };
		const createdAt = createdAtOf(state, row.created_at, null);
		return {
			legacyId: row.id,
			digest: digestOf(row),
			targetTable: "source_fragments",
			targetId: row.id,
			apply: (db) =>
				upsertSourceFragment(db, {
					id: row.id,
					sourceId: row.source_id,
					locator: row.locator,
					byteStart: null,
					byteEnd: null,
					heading: row.heading,
					content: row.content,
					createdAt,
				}),
		};
	};

// --- episode_cards (+ episode_refs) -> episodes / episode_sources -----------------------

export interface EpisodeRow {
	id: string;
	title: string;
	situation: string;
	observations: string;
	action: string;
	outcome: string;
	lesson: string;
	applicability: string;
	anti_applicability: string;
	domains: string;
	technologies: string;
	change_types: string;
	tools: string;
	repo_path: string | null;
	repo_key: string | null;
	source_kind: string;
	source_key: string;
	outcome_kind: string;
	confidence: number;
	status: string;
	stale_at: string | null;
	metadata: string;
	created_at: string;
	updated_at: string;
	importance: number;
	compile_use_count: number;
	decision_use_count: number;
	classification_status: string;
	scope: string;
	project_ref: string | null;
}
export const EPISODES_SQL = `SELECT id, title, situation, observations, action, outcome, lesson,
  applicability, anti_applicability, domains, technologies, change_types, tools, repo_path,
  repo_key, source_kind, source_key, outcome_kind, confidence, status, stale_at, metadata,
  created_at, updated_at, importance, compile_use_count, decision_use_count,
  classification_status, scope, project_ref FROM episode_cards ORDER BY rowid`;

export interface EpisodeRefRow {
	id: string;
	episode_card_id: string;
	ref_kind: string;
	ref_value: string;
	locator: string | null;
	query_hint: string | null;
	metadata: string;
	created_at: string;
}
export const EPISODE_REFS_SQL = `SELECT id, episode_card_id, ref_kind, ref_value, locator,
  query_hint, metadata, created_at FROM episode_refs ORDER BY episode_card_id, id`;

const OUTCOME_KINDS = new Set(["success", "failure", "mixed", "unknown"]);

/** Legacy episode statuses other than `active` that mean the card is no longer valid. */
const RETRACTED_EPISODE_STATUSES = new Set([
	"deprecated",
	"retracted",
	"archived",
]);

function episodeStatus(row: EpisodeRow): EpisodeStatus | null {
	if (RETRACTED_EPISODE_STATUSES.has(row.status)) return "retracted";
	if (row.status !== "active") return null;
	return row.stale_at ? "stale" : "active";
}

export const planEpisode =
	(
		state: ImportState,
		refsByEpisode: Map<string, EpisodeRefRow[]>,
		vibeIds: Set<string>,
	) =>
	(row: EpisodeRow): Planned => {
		const status = episodeStatus(row);
		if (!status) return { skip: "unknown_status" };
		if (!OUTCOME_KINDS.has(row.outcome_kind))
			return { skip: "unknown_outcome_kind" };
		const scope = normalizeScope(row.scope, row.repo_key, row.repo_path);
		if (!scope) return { skip: "unknown_scope" };
		const refs = refsByEpisode.get(row.id) ?? [];
		const createdAt = createdAtOf(state, row.created_at, row.updated_at);
		const updatedAt = updatedAtOf(row.updated_at, createdAt);
		const sources: EpisodeSourceRef[] = refs
			.filter(
				(ref) => ref.ref_kind === "vibe_memory" && vibeIds.has(ref.ref_value),
			)
			.map((ref) => ({
				sourceId: ref.ref_value,
				locator: ref.locator ?? "",
				role: "derived_from",
			}));
		const input: EpisodeInput = {
			id: row.id,
			title: row.title,
			situation: row.situation,
			intent: "",
			decision: "",
			observations: row.observations,
			action: row.action,
			outcome: row.outcome,
			lesson: row.lesson,
			openQuestions: [],
			outcomeKind: row.outcome_kind as EpisodeInput["outcomeKind"],
			eventStart: null,
			eventEnd: null,
			timePrecision: "unknown",
			confidence: percentToUnit(row.confidence),
			importance: percentToUnit(row.importance),
			status,
			space: "coding",
			scope: scope.scope,
			repoKey: scope.repoKey,
			facets: {
				applicability: parseObject(row.applicability),
				antiApplicability: parseObject(row.anti_applicability),
				domains: parseArray(row.domains),
				technologies: parseArray(row.technologies),
				changeTypes: parseArray(row.change_types),
				tools: parseArray(row.tools),
			},
			metadata: {
				legacy: {
					status: row.status,
					scope: row.scope,
					repoKey: row.repo_key,
					repoPath: row.repo_path,
					projectRef: row.project_ref,
					sourceKind: row.source_kind,
					sourceKey: row.source_key,
					classificationStatus: row.classification_status,
					compileUseCount: row.compile_use_count,
					decisionUseCount: row.decision_use_count,
					metadata: parseJson<unknown>(row.metadata, row.metadata),
				},
			},
			createdAt,
			updatedAt,
		};
		return {
			legacyId: row.id,
			digest: digestOf({ row, refs }),
			targetTable: "episodes",
			targetId: row.id,
			apply: (db) => {
				const result = upsertEpisode(db, input);
				replaceEpisodeSources(db, row.id, sources);
				return result;
			},
		};
	};

// --- knowledge_items -> knowledge_items / knowledge_evidence ----------------------------

export interface KnowledgeRow {
	id: string;
	type: string;
	status: string;
	scope: string;
	polarity: string;
	intent_tags: string;
	title: string;
	body: string;
	applies_to: string;
	confidence: number;
	importance: number;
	compile_select_count: number;
	last_compiled_at: string | null;
	agentic_accept_count: number;
	explicit_upvote_count: number;
	explicit_downvote_count: number;
	dynamic_score: number;
	metadata: string;
	created_at: string;
	updated_at: string;
	last_verified_at: string | null;
	classification_status: string;
	project_ref: string | null;
	repo_key: string | null;
	repo_path: string | null;
}
export const KNOWLEDGE_SQL = `SELECT id, type, status, scope, polarity, intent_tags, title, body,
  applies_to, confidence, importance, compile_select_count, last_compiled_at,
  agentic_accept_count, explicit_upvote_count, explicit_downvote_count, dynamic_score, metadata,
  created_at, updated_at, last_verified_at, classification_status, project_ref, repo_key, repo_path
  FROM knowledge_items ORDER BY rowid`;

const GATES = ["importance", "candidate_quality", "applicability", "embedding"];

/** A draft passes when finalize stored it and listed all four quality gates. */
export function draftPassesGates(metadata: Record<string, unknown>): boolean {
	const summary = metadata.finalizeSummary;
	if (!isRecord(summary) || summary.decision !== "stored") return false;
	const gates = summary.qualityGates;
	return Array.isArray(gates) && GATES.every((gate) => gates.includes(gate));
}

function knowledgeStatus(
	state: ImportState,
	row: KnowledgeRow,
	metadata: Record<string, unknown>,
): KnowledgeStatus | null {
	switch (row.status) {
		case "active":
			return "active";
		case "deprecated":
			return "retracted";
		case "draft": {
			state.draft.total++;
			const passed = draftPassesGates(metadata);
			state.draft[passed ? "gatePassed" : "gateFailed"]++;
			return passed ? "active" : "candidate";
		}
		default:
			return null;
	}
}

/**
 * What a re-import must not undo. The legacy row only says `active`, so it cannot overwrite
 * what the re-distillation decided: an atom it superseded stays `superseded`, and one it
 * retracted (the loser of a conflict, `retracted` with `evidence_only`) stays `retracted`.
 * The protection rests on `status` and `retrieval`, not on `metadata.distill`. A legacy
 * `deprecated` still retracts (a superseded atom becomes `retracted`). A `retracted` row that
 * stays `searchable` came from a legacy `deprecated` earlier and follows the legacy row again.
 * The `metadata.distill` the re-distillation wrote is kept, and when the title or body changed
 * it is marked `needsReassess`. `retrieval` is not part of the upsert, so it stays as it is.
 */
export function keepDistillState(
	existing: KnowledgeItem | null,
	input: KnowledgeInput,
): KnowledgeInput {
	if (!existing) return input;
	const distill = isRecord(existing.metadata.distill)
		? existing.metadata.distill
		: null;
	const held =
		existing.status === "superseded" ||
		(existing.status === "retracted" && existing.retrieval === "evidence_only");
	const settled = held || existing.retrieval === "evidence_only";
	const changed =
		existing.title !== input.title || existing.body !== input.body;
	const needsReassess = settled && changed;
	if (!held && !distill && !needsReassess) return input;
	return {
		...input,
		status:
			held && input.status !== "retracted" ? existing.status : input.status,
		metadata:
			distill || needsReassess
				? {
						...input.metadata,
						distill: {
							...distill,
							...(needsReassess ? { needsReassess: true } : {}),
						},
					}
				: input.metadata,
	};
}

export interface KnowledgePlanDeps {
	state: ImportState;
	provenance: ProvenanceIndex;
}

export const planKnowledge =
	({ state, provenance }: KnowledgePlanDeps) =>
	(row: KnowledgeRow): Planned => {
		if (row.type !== "rule" && row.type !== "procedure")
			return { skip: "unknown_type" };
		if (row.polarity !== "positive" && row.polarity !== "negative")
			return { skip: "unknown_polarity" };
		const metadata = parseObject(row.metadata);
		const status = knowledgeStatus(state, row, metadata);
		if (!status) return { skip: "unknown_status" };
		const scope = normalizeScope(row.scope, row.repo_key, row.repo_path);
		if (!scope) return { skip: "unknown_scope" };
		const traced = resolveProvenance(provenance, row.id, metadata);
		state.provenance[traced.status]++;
		state.provenance.byOrigin[traced.origin] =
			(state.provenance.byOrigin[traced.origin] ?? 0) + 1;
		if (status === "active" && traced.status === "unresolved")
			state.provenance.activeUnresolved++;
		const createdAt = createdAtOf(state, row.created_at, row.updated_at);
		const updatedAt = updatedAtOf(row.updated_at, createdAt);
		const input: KnowledgeInput = {
			id: row.id,
			layer: "atom",
			type: row.type,
			polarity: row.polarity,
			title: row.title,
			body: row.body,
			appliesWhen: [],
			notAppliesWhen: [],
			steps: [],
			facets: {
				appliesTo: parseObject(row.applies_to),
				intentTags: parseArray(row.intent_tags),
			},
			confidence: percentToUnit(row.confidence),
			importance: percentToUnit(row.importance),
			status,
			space: "coding",
			scope: scope.scope,
			repoKey: scope.repoKey,
			validFrom: null,
			validUntil: null,
			provenanceStatus: traced.status,
			metadata: {
				legacy: {
					status: row.status,
					scope: row.scope,
					repoKey: row.repo_key,
					repoPath: row.repo_path,
					projectRef: row.project_ref,
					dynamicScore: row.dynamic_score,
					compileSelectCount: row.compile_select_count,
					classificationStatus: row.classification_status,
				},
			},
			createdAt,
			updatedAt,
		};
		const evidence: EvidenceInput[] = traced.evidence;
		return {
			legacyId: row.id,
			digest: digestOf({
				row,
				provenance: { status: traced.status, evidence },
			}),
			targetTable: "knowledge_items",
			targetId: row.id,
			apply: (db) => {
				const result = upsertKnowledgeItem(
					db,
					keepDistillState(getKnowledgeById(db, row.id), input),
				);
				replaceKnowledgeEvidence(
					db,
					row.id,
					"legacy_import",
					evidence,
					createdAt,
				);
				return result;
			},
		};
	};

// --- knowledge_usage_events -> usage_events ---------------------------------------------

export interface UsageRow {
	id: string;
	run_id: string;
	knowledge_id: string;
	verdict: string;
	actor: string;
	reason: string | null;
	metadata: string;
	created_at: string;
	updated_at: string;
}
export const USAGE_SQL = `SELECT id, run_id, knowledge_id, verdict, actor, reason, metadata,
  created_at, updated_at FROM knowledge_usage_events ORDER BY rowid`;

const VERDICTS = new Set<string>([
	"presented",
	"used",
	"not_used",
	"wrong",
	"off_topic",
]);
const ACTORS = new Set<string>(["agent", "system", "user", "eumenes"]);

export const planUsage =
	(state: ImportState) =>
	(row: UsageRow): Planned => {
		if (!VERDICTS.has(row.verdict)) return { skip: "unknown_verdict" };
		if (!ACTORS.has(row.actor)) return { skip: "unknown_actor" };
		const occurredAt = createdAtOf(state, row.created_at, row.updated_at);
		const parsed = parseJson<unknown>(row.metadata, {});
		return {
			legacyId: row.id,
			digest: digestOf(row),
			// Usage events are immutable: a changed legacy row is reported, never applied.
			immutable: true,
			previousDigests: [digestOf(row, PREVIOUS_VERSION)],
			targetTable: "usage_events",
			targetId: row.id,
			apply: (db) =>
				insertUsageEvent(db, {
					id: row.id,
					ownerKind: "knowledge",
					ownerId: row.knowledge_id,
					channel: "compile",
					verdict: row.verdict as UsageVerdict,
					actor: row.actor as UsageActor,
					runRef: row.run_id,
					reason: row.reason,
					origin: "legacy_import",
					occurredAt,
					metadata: isRecord(parsed) ? parsed : { value: parsed },
				}),
		};
	};

// --- knowledge_items_vec_fallback -> vectors --------------------------------------------

export interface VectorRow {
	knowledge_id: string;
	embedding_json: string;
	embedding_dimension: number;
	content_hash: string;
	updated_at: string;
	title: string | null;
	body: string | null;
}
export const VECTORS_SQL = `SELECT v.knowledge_id, v.embedding_json, v.embedding_dimension,
  v.content_hash, v.updated_at, k.title, k.body
  FROM knowledge_items_vec_fallback v LEFT JOIN knowledge_items k ON k.id = v.knowledge_id
  ORDER BY v.rowid`;

/** 384 finite numbers with an L2 norm of 1 +- 1e-3, or null. */
function readEmbedding(row: VectorRow): Float32Array | null {
	if (row.embedding_dimension !== LEGACY_VECTOR_SPACE.dimension) return null;
	const parsed = parseJson<unknown>(row.embedding_json, null);
	if (!Array.isArray(parsed) || parsed.length !== LEGACY_VECTOR_SPACE.dimension)
		return null;
	if (!parsed.every((v) => typeof v === "number" && Number.isFinite(v)))
		return null;
	const vector = Float32Array.from(parsed as number[]);
	return Math.abs(l2norm(vector) - 1) <= 1e-3 ? vector : null;
}

function sameBits(a: Float32Array, b: Float32Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++)
		if (Object.is(a[i], b[i]) === false) return false;
	return true;
}

export const planVector =
	(state: ImportState) =>
	(row: VectorRow): Planned => {
		if (row.title === null || row.body === null) {
			state.vectors.invalid++;
			return { skip: "knowledge_missing" };
		}
		const vector = readEmbedding(row);
		if (!vector) {
			state.vectors.invalid++;
			return { skip: "invalid_embedding" };
		}
		const fresh =
			row.content_hash === knowledgeContentDigest(row.title, row.body);
		state.vectors.imported++;
		if (!fresh) state.vectors.stale++;
		const updatedAt = updatedAtOf(row.updated_at, state.nowIso);
		return {
			legacyId: row.knowledge_id,
			digest: digestOf(row),
			targetTable: "vectors",
			targetId: row.knowledge_id,
			apply: (db: Database) => {
				ensureVectorSpace(db, LEGACY_VECTOR_SPACE, state.nowIso);
				const existing = getVector(
					db,
					"knowledge",
					row.knowledge_id,
					state.spaceKey,
				);
				if (existing) {
					// A LARM vector is the indexing job's to refresh, never the importer's.
					if (existing.origin === "larm") return "unchanged";
					// Same bits and digest: keep the verification the vector already earned.
					if (
						existing.contentDigest === row.content_hash &&
						sameBits(existing.vector, vector)
					)
						return "unchanged";
				}
				return upsertVector(db, {
					ownerKind: "knowledge",
					ownerId: row.knowledge_id,
					spaceKey: state.spaceKey,
					// The digest the vector was made from: a stale one must keep looking stale.
					contentDigest: row.content_hash,
					vector,
					origin: "legacy_import",
					verification: fresh ? "unverified" : "stale",
					now: updatedAt,
				});
			},
		};
	};
