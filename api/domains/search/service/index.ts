import type { Database } from "bun:sqlite";
import { makeHandle } from "../../../infrastructure/handle";
import type { KnowledgeLayer, KnowledgeType, Polarity } from "../../knowledge";
import { edgesFrom, edgesTo, getCluster, listClusters } from "../../map";
import { topK } from "../../vectors";
import {
	type DegradedReason,
	type SearchDeps,
	SearchError,
	type SearchHit,
	type SearchKind,
	type SearchLane,
	type SearchRequest,
	type SearchResponse,
	type SearchService,
} from "../contracts";
import {
	type Candidate,
	type Filter,
	runLexicalLane,
	runVectorRows,
} from "./lanes";
import { tokenizeQuery } from "./tokenizer";

export { tokenizeQuery };

const RRF_K = 60;
const WEIGHT: Record<SearchLane, number> = {
	fts: 1.0,
	vector: 1.0,
	short: 0.5,
};
const ALL_LANES: SearchLane[] = ["fts", "short", "vector"];
const LANE_ORDER: SearchLane[] = ["fts", "vector", "short"];
const KINDS = new Set<string>(["knowledge", "episode"]);
const SPACES = new Set<string>(["coding", "general", "eumenes", "personal"]);
const DEFAULT_TIMEOUT_MS = 2000;
const LANE_LIMIT = 100;
const SUMMARY_LENGTH = 280;
const SITUATION_SUMMARY_LENGTH = 120;
/** Atoms are the raw material of a canonical; at equal merit the canonical leads. */
const ATOM_FACTOR = 0.8;
const MAX_HIT_THEMES = 3;
const DEFAULT_LAYERS: KnowledgeLayer[] = ["canonical", "atom"];
const DEGRADED_ORDER: DegradedReason[] = [
	"vector_unavailable",
	"vector_unverified",
	"no_lexical_terms",
	"theme_unavailable",
];

interface LaneEntry {
	lane: SearchLane;
	rank: number;
	raw: number;
}
interface Doc {
	kind: SearchKind;
	id: string;
	lanes: LaneEntry[];
	score: number;
	/** knowledge only, read when the doc is scored */
	layer: KnowledgeLayer | null;
}

function validate(req: SearchRequest): void {
	const query = typeof req.query === "string" ? req.query.trim() : "";
	const queryLength = [...query].length;
	if (queryLength < 1 || queryLength > 512)
		throw new SearchError("invalid_query");
	if (
		!Array.isArray(req.kinds) ||
		req.kinds.length === 0 ||
		!req.kinds.every((k) => KINDS.has(k))
	)
		throw new SearchError("invalid_query");
	if (
		!Array.isArray(req.spaces) ||
		req.spaces.length === 0 ||
		!req.spaces.every((s) => SPACES.has(s))
	)
		throw new SearchError("invalid_query");
	if (req.spaces.includes("personal"))
		throw new SearchError("space_not_allowed");
	if (!Number.isInteger(req.limit) || req.limit < 1 || req.limit > 50)
		throw new SearchError("invalid_query");
	if (
		req.lanes !== undefined &&
		(!Array.isArray(req.lanes) ||
			!req.lanes.every((l) => ALL_LANES.includes(l)))
	)
		throw new SearchError("invalid_query");
}

function callerAbort(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw signal.reason ?? new Error("aborted");
}

/** The query vector, or null when it cannot be had in time (the lane is then dropped). */
async function resolveQueryVector(
	deps: SearchDeps,
	req: SearchRequest,
	query: string,
	signal: AbortSignal | undefined,
): Promise<Float32Array | null> {
	let vector: Float32Array | undefined = req.queryVector;
	if (!vector) {
		const embed = deps.embedQuery;
		if (!embed) return null;
		const controller = new AbortController();
		const timeoutMs = deps.queryTimeoutMs ?? DEFAULT_TIMEOUT_MS;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let onAbort: (() => void) | undefined;
		try {
			const aborted = new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					controller.abort();
					reject(new Error("embed_timeout"));
				}, timeoutMs);
				onAbort = () => {
					controller.abort();
					reject(new Error("embed_aborted"));
				};
				signal?.addEventListener("abort", onAbort, { once: true });
			});
			const pending = embed(query, controller.signal);
			pending.catch(() => {});
			vector = await Promise.race([pending, aborted]);
		} catch {
			callerAbort(signal);
			return null;
		} finally {
			if (timer) clearTimeout(timer);
			if (onAbort) signal?.removeEventListener("abort", onAbort);
		}
	}
	callerAbort(signal);
	if (!(vector instanceof Float32Array) || vector.length === 0) return null;
	for (const value of vector) if (!Number.isFinite(value)) return null;
	return vector;
}

const squash = (text: string) => text.replace(/\s+/g, " ").trim();
const cutTo = (text: string, length: number) =>
	[...squash(text)].slice(0, length).join("");
const cut = (text: string) => cutTo(text, SUMMARY_LENGTH);

/** The theme and every theme below it (`broader` edges and `parent_id`), cycle safe. */
function themeSubtree(db: Database, themeId: string): string[] {
	const seen = new Set<string>([themeId]);
	const queue = [themeId];
	for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
		const children = [
			...edgesTo(db, "theme", next, "broader")
				.filter((e) => e.status === "active" && e.src.kind === "theme")
				.map((e) => e.src.id),
			...listClusters(db, { kind: "theme", parentId: next }).map((c) => c.id),
		];
		for (const child of children)
			if (!seen.has(child)) {
				seen.add(child);
				queue.push(child);
			}
	}
	return [...seen];
}

/** Theme ids a knowledge row is about: level 2 when it has any, else level 1; at most 3. */
function themesOf(db: Database, knowledgeId: string): string[] {
	const byLevel = new Map<number, { id: string; confidence: number }[]>();
	for (const edge of edgesFrom(db, "knowledge", knowledgeId, "about")) {
		if (edge.status !== "active" || edge.dst.kind !== "theme") continue;
		const cluster = getCluster(db, edge.dst.id);
		if (!cluster || cluster.kind !== "theme" || cluster.state === "rejected")
			continue;
		const list = byLevel.get(cluster.level) ?? [];
		list.push({ id: cluster.id, confidence: edge.confidence });
		byLevel.set(cluster.level, list);
	}
	const chosen = byLevel.get(2) ?? byLevel.get(1) ?? [];
	return chosen
		.sort(
			(a, b) =>
				b.confidence - a.confidence || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
		)
		.slice(0, MAX_HIT_THEMES)
		.map((theme) => theme.id);
}

function hydrate(
	db: Database,
	doc: Doc,
): Omit<SearchHit, "score" | "lanes"> | null {
	if (doc.kind === "knowledge") {
		const row = db
			.query(
				"SELECT handle, title, body, situation, layer, type, polarity, status, space, confidence FROM knowledge_items WHERE id = ?",
			)
			.get(doc.id) as {
			handle: string;
			title: string;
			body: string;
			situation: string;
			layer: KnowledgeLayer;
			type: KnowledgeType;
			polarity: Polarity;
			status: string;
			space: SearchHit["space"];
			confidence: number;
		} | null;
		if (!row) return null;
		return {
			kind: "knowledge",
			id: doc.id,
			handle: row.handle || makeHandle("knowledge", doc.id),
			title: row.title,
			summary:
				row.layer === "canonical" && squash(row.situation) !== ""
					? cut(
							`${cutTo(row.situation, SITUATION_SUMMARY_LENGTH)} — ${row.body}`,
						)
					: cut(row.body),
			type: row.type,
			polarity: row.polarity,
			status: row.status,
			layer: row.layer,
			situation: row.layer === "canonical" ? row.situation : "",
			themes: themesOf(db, doc.id),
			space: row.space,
			confidence: row.confidence,
		};
	}
	const row = db
		.query(
			"SELECT handle, title, situation, outcome, lesson, status, space, confidence FROM episodes WHERE id = ?",
		)
		.get(doc.id) as {
		handle: string;
		title: string;
		situation: string;
		outcome: string;
		lesson: string;
		status: string;
		space: SearchHit["space"];
		confidence: number;
	} | null;
	if (!row) return null;
	const source =
		[row.lesson, row.outcome, row.situation].find((t) => squash(t) !== "") ??
		"";
	return {
		kind: "episode",
		id: doc.id,
		handle: row.handle || makeHandle("episode", doc.id),
		title: row.title,
		summary: cut(source),
		type: null,
		polarity: null,
		status: row.status,
		layer: null,
		situation: "",
		themes: [],
		space: row.space,
		confidence: row.confidence,
	};
}

export function createSearch(deps: SearchDeps): SearchService {
	return {
		async search(req, opts) {
			validate(req);
			callerAbort(opts?.signal);
			const query = req.query.trim();
			const lanes = req.lanes ?? ALL_LANES;
			const kinds = [...new Set(req.kinds)];
			const filter: Filter = {
				spaces: [...new Set(req.spaces)],
				repoKey: req.repoKey ?? null,
				types:
					req.types && req.types.length > 0 ? [...new Set(req.types)] : null,
				layers:
					req.layers && req.layers.length > 0
						? [...new Set(req.layers)]
						: DEFAULT_LAYERS,
				includeSuperseded: req.includeSuperseded === true,
				themeIds: null,
			};
			const degraded = new Set<DegradedReason>();
			const lanesUsed = new Set<SearchLane>();
			const candidateCounts: Record<SearchLane, number> = {
				fts: 0,
				short: 0,
				vector: 0,
			};

			const { ftsTerms, shortTerms } = tokenizeQuery(query);
			const wantFts = lanes.includes("fts") && ftsTerms.length > 0;
			const wantShort = lanes.includes("short") && shortTerms.length > 0;
			if (
				(lanes.includes("fts") || lanes.includes("short")) &&
				ftsTerms.length === 0 &&
				shortTerms.length === 0
			)
				degraded.add("no_lexical_terms");

			let queryVector: Float32Array | null = null;
			if (lanes.includes("vector")) {
				queryVector = await resolveQueryVector(deps, req, query, opts?.signal);
				if (!queryVector) degraded.add("vector_unavailable");
			}

			const docs = new Map<string, Doc>();
			const addLane = (
				kind: SearchKind,
				lane: SearchLane,
				ranked: Candidate[],
			) => {
				candidateCounts[lane] += ranked.length;
				ranked.forEach((candidate, index) => {
					const key = `${kind}:${candidate.id}`;
					let doc = docs.get(key);
					if (!doc) {
						doc = { kind, id: candidate.id, lanes: [], score: 0, layer: null };
						docs.set(key, doc);
					}
					doc.lanes.push({ lane, rank: index + 1, raw: candidate.raw });
				});
			};

			const hydrated = deps.store.readSnapshot((db) => {
				if (req.theme !== undefined) {
					// An empty theme table cannot narrow anything; say so instead of returning nothing.
					if (listClusters(db, { kind: "theme" }).length === 0)
						degraded.add("theme_unavailable");
					else filter.themeIds = themeSubtree(db, req.theme);
				}
				for (const kind of kinds) {
					if (wantFts) {
						lanesUsed.add("fts");
						addLane(
							kind,
							"fts",
							runLexicalLane(db, kind, "fts", ftsTerms, filter, LANE_LIMIT),
						);
					}
					if (wantShort) {
						lanesUsed.add("short");
						addLane(
							kind,
							"short",
							runLexicalLane(db, kind, "short", shortTerms, filter, LANE_LIMIT),
						);
					}
				}
				if (queryVector) {
					const dimension = db
						.query("SELECT dimension FROM vector_spaces WHERE space_key = ?")
						.get(deps.spaceKey) as { dimension: number } | null;
					if (dimension && dimension.dimension !== queryVector.length) {
						degraded.add("vector_unavailable");
					} else {
						let usable = 0;
						const unverifiedCounters: (() => number)[] = [];
						for (const kind of kinds) {
							const { rows, countUnverified } = runVectorRows(
								db,
								kind,
								deps.spaceKey,
								filter,
							);
							unverifiedCounters.push(countUnverified);
							const counted = (function* () {
								for (const row of rows) {
									usable += 1;
									yield row;
								}
							})();
							const top = topK(queryVector, counted, LANE_LIMIT);
							addLane(
								kind,
								"vector",
								top.map((entry) => ({ id: entry.ownerId, raw: entry.score })),
							);
						}
						if (usable > 0) lanesUsed.add("vector");
						else if (unverifiedCounters.some((count) => count() > 0))
							degraded.add("vector_unverified");
					}
				}

				const layerOf = db.query(
					"SELECT layer FROM knowledge_items WHERE id = ?",
				);
				for (const doc of docs.values()) {
					let score = 0;
					for (const lane of LANE_ORDER) {
						const entry = doc.lanes.find((l) => l.lane === lane);
						if (entry) score += WEIGHT[lane] / (RRF_K + entry.rank);
					}
					if (doc.kind === "knowledge") {
						doc.layer =
							(layerOf.get(doc.id) as { layer: KnowledgeLayer } | null)
								?.layer ?? null;
						if (doc.layer === "atom") score *= ATOM_FACTOR;
					}
					doc.score = score;
				}
				const canonicalFirst = (doc: Doc) =>
					doc.layer === "canonical" ? 0 : 1;
				const bestRank = (doc: Doc) =>
					Math.min(...doc.lanes.map((l) => l.rank));
				// Scores that differ only by float noise are ties.
				const bucket = (doc: Doc) => Math.round(doc.score * 1e12);
				const ordered = [...docs.values()].sort(
					(a, b) =>
						bucket(b) - bucket(a) ||
						canonicalFirst(a) - canonicalFirst(b) ||
						bestRank(a) - bestRank(b) ||
						(a.kind === b.kind ? 0 : a.kind === "knowledge" ? -1 : 1) ||
						(a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
				);
				const hits: SearchHit[] = [];
				for (const doc of ordered) {
					if (hits.length >= req.limit) break;
					const base = hydrate(db, doc);
					if (!base) continue;
					hits.push({
						...base,
						score: doc.score,
						lanes: LANE_ORDER.flatMap((lane) =>
							doc.lanes.filter((l) => l.lane === lane),
						),
					});
				}
				return hits;
			});

			const response: SearchResponse = {
				hits: hydrated,
				degraded: DEGRADED_ORDER.filter((reason) => degraded.has(reason)),
				lanesUsed: ALL_LANES.filter((lane) => lanesUsed.has(lane)),
				candidateCounts,
			};
			return response;
		},
	};
}
