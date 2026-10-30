import type { Database } from "bun:sqlite";
import { sha256Hex } from "../../../../infrastructure/digest";
import { dot } from "../../../../infrastructure/vector";
import {
	edgeId,
	edgesFrom,
	edgesTo,
	listClusterMembers,
	listClusters,
	memberDigest,
	memberKey,
	setEdgeStatus,
	upsertCluster,
	upsertEdge,
	type ClusterInput,
	type ClusterMember,
	type ClusterRow,
} from "../../../map";
import { normalized, sphericalKMeans } from "./kmeans";

/** Members that are listed as `core`: the items given to the model. */
export const CORE_SIZE = 20;
/** Share of the members two versions of a theme must have in common to be the same theme. */
export const JACCARD_MIN = 0.5;
export const EXTRACTOR_VERSION = "theme.kmeans.v1";

export interface ThemePoint {
	id: string;
	contentDigest: string;
	vector: Float32Array;
}

/** A theme as the clustering found it, before it gets an id. */
export interface RawTheme {
	level: 1 | 2;
	/** Index into the raw list of the broader theme (level 2 only). */
	parent: number | null;
	members: { id: string; similarity: number }[];
}

export interface RawThemes {
	themes: RawTheme[];
	k2: number;
	k1: number;
}

/**
 * Two levels (6.9): k2 = round(N/25) narrow themes by spherical k-means over the canonical
 * vectors, then k1 = round(k2/8) broad themes by the same over the narrow centers. A broad theme
 * holds all canonicals of its narrow themes. The result depends only on the set of points.
 */
export async function clusterThemes(
	points: readonly ThemePoint[],
): Promise<RawThemes> {
	const n = points.length;
	if (n === 0) return { themes: [], k2: 0, k1: 0 };
	const k2 = Math.max(1, Math.round(n / 25));
	const low = await sphericalKMeans(
		points.map((p) => p.id),
		points.map((p) => p.vector),
		k2,
	);
	const lowMembers: ThemePoint[][] = low.centers.map(() => []);
	points.forEach((p, i) => lowMembers[low.assignments[i]!]!.push(p));
	const k1 = Math.min(
		low.centers.length,
		Math.max(1, Math.round(low.centers.length / 8)),
	);
	const high = await sphericalKMeans(
		lowMembers.map((m) => m.map((p) => p.id).sort()[0]!),
		low.centers,
		k1,
	);
	const themes: RawTheme[] = [];
	// Broad themes first so that `parent` refers to an earlier entry.
	const highMembers: ThemePoint[][] = high.centers.map(() => []);
	lowMembers.forEach((members, c) => {
		highMembers[high.assignments[c]!]!.push(...members);
	});
	high.centers.forEach((center, h) => {
		themes.push({
			level: 1,
			parent: null,
			members: highMembers[h]!.map((p) => ({
				id: p.id,
				similarity: dot(normalized(p.vector), center),
			})),
		});
	});
	lowMembers.forEach((members, c) => {
		themes.push({
			level: 2,
			parent: high.assignments[c]!,
			members: members.map((p) => ({
				id: p.id,
				similarity: dot(normalized(p.vector), low.centers[c]!),
			})),
		});
	});
	return { themes, k2: low.centers.length, k1: high.centers.length };
}

export interface PlannedTheme {
	id: string;
	level: 1 | 2;
	/** Index into `PlannedThemes.themes` of the broader theme. */
	parent: number | null;
	members: ClusterMember[];
	memberDigest: string;
	previous: ClusterRow | null;
	input: ClusterInput;
	/** The knowledge page must be (re)written by the model. */
	needsJob: boolean;
}

export interface PlannedThemes {
	themes: PlannedTheme[];
	/** Previous themes that no new theme took over. */
	dropped: ClusterInput[];
	/** Previous theme ids (kept or dropped), for retracting the edges that no longer hold. */
	previousIds: string[];
	algorithm: string;
	inherited: number;
}

const sortedIds = (members: readonly { id: string }[]) =>
	members.map((m) => m.id).sort();

const newThemeId = (level: number, ids: readonly string[]) =>
	`thm_${sha256Hex(`${level}|${ids.join(",")}`).slice(0, 32)}`;

/**
 * Matches the new themes with the stored ones (read only). A new theme takes over the id, and so
 * the handle, of the stored theme of the same level with which its members have a Jaccard index
 * of at least 0.5; pairs are taken from the largest index down, each theme once.
 */
export function reconcileThemes(
	db: Database,
	raw: RawThemes,
	digests: ReadonlyMap<string, string>,
	now: string,
	unverified: boolean,
): PlannedThemes {
	const previous = listClusters(db, { kind: "theme" });
	const previousMembers = new Map(
		previous.map((c) => [
			c.id,
			new Set(listClusterMembers(db, c.id).map((m) => m.id)),
		]),
	);
	const idOf = new Map<number, string>();
	const taken = new Set<string>();
	const pairs: { jaccard: number; old: string; index: number }[] = [];
	const newSets = raw.themes.map((t) => new Set(t.members.map((m) => m.id)));
	for (const old of previous) {
		const oldSet = previousMembers.get(old.id)!;
		if (oldSet.size === 0) continue;
		raw.themes.forEach((t, index) => {
			if (t.level !== old.level) return;
			let shared = 0;
			for (const id of oldSet) if (newSets[index]!.has(id)) shared++;
			if (shared === 0) return;
			const jaccard = shared / (oldSet.size + newSets[index]!.size - shared);
			if (jaccard >= JACCARD_MIN) pairs.push({ jaccard, old: old.id, index });
		});
	}
	pairs.sort(
		(a, b) =>
			b.jaccard - a.jaccard ||
			(a.old < b.old ? -1 : a.old > b.old ? 1 : 0) ||
			a.index - b.index,
	);
	for (const p of pairs) {
		if (taken.has(p.old) || idOf.has(p.index)) continue;
		taken.add(p.old);
		idOf.set(p.index, p.old);
	}
	raw.themes.forEach((t, index) => {
		if (!idOf.has(index))
			idOf.set(index, newThemeId(t.level, sortedIds(t.members)));
	});

	const algorithm = `kmeans.v1|k2=${raw.k2}|k1=${raw.k1}${unverified ? "|unverified" : ""}`;
	const byId = new Map(previous.map((c) => [c.id, c]));
	const themes: PlannedTheme[] = raw.themes.map((t, index) => {
		const id = idOf.get(index)!;
		const ranked = [...t.members].sort(
			(a, b) => b.similarity - a.similarity || (a.id < b.id ? -1 : 1),
		);
		const core = new Set(ranked.slice(0, CORE_SIZE).map((m) => m.id));
		const members: ClusterMember[] = t.members
			.map((m) => ({
				kind: "knowledge" as const,
				id: m.id,
				role: core.has(m.id) ? ("core" as const) : ("member" as const),
				similarity: m.similarity,
			}))
			.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
		const digest = memberDigest(
			members,
			new Map(
				members.map((m) => [memberKey(m.kind, m.id), digests.get(m.id)!]),
			),
		);
		const before = byId.get(id) ?? null;
		const same = before !== null && before.memberDigest === digest;
		const state = before === null ? "pending" : same ? before.state : "stale";
		return {
			id,
			level: t.level,
			parent: t.parent,
			members,
			memberDigest: digest,
			previous: before,
			needsJob: state === "pending" || state === "stale" || state === "review",
			input: {
				id,
				kind: "theme",
				parentId: null, // filled below
				level: t.level,
				name: before?.name ?? "",
				aliases: before?.aliases ?? [],
				description: before?.description ?? "",
				summary: before?.summary ?? {},
				state,
				algorithm,
				memberDigest: digest,
				members,
				createdAt: before?.createdAt ?? now,
				updatedAt: now,
			},
		};
	});
	for (const theme of themes)
		theme.input.parentId =
			theme.parent === null ? null : themes[theme.parent]!.id;

	const kept = new Set(themes.map((t) => t.id));
	const emptyDigest = memberDigest([], new Map());
	const dropped: ClusterInput[] = previous
		.filter((c) => !kept.has(c.id))
		.map((c) => ({
			id: c.id,
			kind: "theme",
			parentId: c.parentId,
			level: c.level,
			name: c.name,
			aliases: c.aliases,
			description: c.description,
			summary: c.summary,
			state: "stale",
			algorithm: c.algorithm,
			memberDigest: emptyDigest,
			members: [],
			createdAt: c.createdAt,
			updatedAt: now,
		}));
	return {
		themes,
		dropped,
		previousIds: previous.map((c) => c.id),
		algorithm,
		inherited: themes.filter((t) => t.previous !== null).length,
	};
}

/** The leaf theme (level 2) of every canonical. */
export function leafThemeOf(plan: PlannedThemes): Map<string, string> {
	const out = new Map<string, string>();
	for (const t of plan.themes)
		if (t.level === 2) for (const m of t.members) out.set(m.id, t.id);
	return out;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/**
 * Writes the themes, their members and the edges `about` (canonical to its narrow theme) and
 * `broader` (narrow to broad), origin clustering. Edges that an earlier version made and this one
 * does not are retracted; a theme nobody took over is emptied and marked stale. The caller owns
 * the transaction.
 */
export function applyThemes(
	db: Database,
	plan: PlannedThemes,
	now: string,
): void {
	// The broad themes come first in the list, so a parent row exists before its children.
	for (const t of plan.themes) upsertCluster(db, t.input);
	for (const d of plan.dropped) upsertCluster(db, d);

	const wanted = new Set<string>();
	const put = (
		src: { kind: "knowledge" | "theme"; id: string },
		relation: "about" | "broader",
		dst: { kind: "theme"; id: string },
		confidence: number,
		evidence: Record<string, unknown>,
	) => {
		wanted.add(edgeId(src, relation, dst));
		upsertEdge(db, {
			src,
			relation,
			dst,
			origin: "clustering",
			status: "active",
			confidence,
			evidence,
			extractorVersion: EXTRACTOR_VERSION,
			at: now,
		});
	};
	for (const t of plan.themes) {
		if (t.level !== 2) continue;
		for (const m of t.members)
			put(
				{ kind: "knowledge", id: m.id },
				"about",
				{ kind: "theme", id: t.id },
				clamp01(m.similarity ?? 0),
				{ similarity: m.similarity, role: m.role },
			);
		if (t.parent !== null) {
			const parent = plan.themes[t.parent]!;
			put(
				{ kind: "theme", id: t.id },
				"broader",
				{ kind: "theme", id: parent.id },
				1,
				{
					level: 2,
				},
			);
		}
	}
	for (const id of new Set([
		...plan.previousIds,
		...plan.themes.map((t) => t.id),
	])) {
		for (const edge of edgesTo(db, "theme", id, "about"))
			if (
				edge.origin === "clustering" &&
				edge.status !== "retracted" &&
				!wanted.has(edge.id)
			)
				setEdgeStatus(db, edge.id, "retracted", now);
		for (const edge of edgesFrom(db, "theme", id, "broader"))
			if (
				edge.origin === "clustering" &&
				edge.status !== "retracted" &&
				!wanted.has(edge.id)
			)
				setEdgeStatus(db, edge.id, "retracted", now);
	}
}
