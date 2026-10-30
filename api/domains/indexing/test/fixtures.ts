import { sha256Hex } from "../../../infrastructure/digest";
import { tempStore } from "../../../infrastructure/sqlite/test-support";
import { l2norm } from "../../../infrastructure/vector";
import {
	migrations as experienceMigrations,
	upsertEpisode,
} from "../../experience";
import {
	migrations as knowledgeMigrations,
	upsertKnowledgeItem,
} from "../../knowledge";
import {
	type EmbeddingInputType,
	LARM_EMBEDDING_SPACE,
	type LarmEmbeddingClient,
	LarmError,
} from "../../larm";
import { migrations as sourcesMigrations } from "../../sources";
import {
	ensureVectorSpace,
	migrations as vectorMigrations,
	upsertVector,
	type VectorOrigin,
	type VectorOwnerKind,
	type VectorVerification,
} from "../../vectors";
import type { IndexingDeps } from "../contracts";

export const T = "2026-10-30T00:00:00.000Z";
export const NOW = new Date("2026-10-30T12:00:00.000Z");

/** A deterministic unit vector for a text: the same text always gives the same vector. */
export function fakeVector(text: string): Float32Array {
	const out = new Float32Array(LARM_EMBEDDING_SPACE.dimension);
	let seed = Buffer.from(sha256Hex(text), "hex");
	for (let i = 0; i < out.length; i++) {
		if (i % 32 === 0 && i > 0) seed = Buffer.from(sha256Hex(seed), "hex");
		out[i] = seed[i % 32]! - 127.5;
	}
	const norm = l2norm(out);
	return out.map((v) => v / norm);
}

export interface FakeLarm extends LarmEmbeddingClient {
	calls: { texts: string[]; type: EmbeddingInputType }[];
	/** Called before each embed; may throw to simulate a failure. */
	onEmbed: (call: number, texts: string[]) => void;
	/** Text transform applied before vectorising (to simulate a server-side prefix). */
	transform: (text: string) => string;
}

export function fakeLarm(): FakeLarm {
	const client: FakeLarm = {
		calls: [],
		onEmbed: () => {},
		transform: (text) => text,
		status: () => ({
			configured: true,
			tokenPresent: true,
			connection: "ready",
			lastError: null,
		}),
		async embed(texts, type) {
			client.calls.push({ texts, type });
			client.onEmbed(client.calls.length, texts);
			return texts.map((t) => fakeVector(client.transform(t)));
		},
		async release() {},
	};
	return client;
}

export function setup() {
	const t = tempStore([
		...sourcesMigrations,
		...experienceMigrations,
		...knowledgeMigrations,
		...vectorMigrations,
	]);
	const larm = fakeLarm();
	const sleeps: number[] = [];
	const logs: string[] = [];
	const deps: IndexingDeps = {
		store: t.store,
		larm,
		spaceKey: "",
		now: () => NOW,
		log: (line) => logs.push(line),
		sleep: async (ms) => {
			sleeps.push(ms);
		},
	};
	return { ...t, larm, sleeps, logs, deps };
}

export async function initSpace(deps: IndexingDeps) {
	deps.spaceKey = await deps.store.write((db) =>
		ensureVectorSpace(db, LARM_EMBEDDING_SPACE, T),
	);
	return deps.spaceKey;
}

export const kText = (title: string, body: string) => `${title}\n${body}`;

export async function addKnowledge(
	deps: IndexingDeps,
	id: string,
	over: { title?: string; body?: string; status?: "active" | "retracted" } = {},
) {
	await deps.store.write((db) =>
		upsertKnowledgeItem(db, {
			id,
			layer: "atom",
			type: "rule",
			polarity: "positive",
			title: over.title ?? `title ${id}`,
			body: over.body ?? `body ${id}`,
			appliesWhen: [],
			notAppliesWhen: [],
			steps: [],
			facets: {},
			confidence: 0.8,
			importance: 0.5,
			status: over.status ?? "active",
			space: "coding",
			scope: "global",
			repoKey: null,
			validFrom: null,
			validUntil: null,
			provenanceStatus: "resolved",
			metadata: {},
			createdAt: T,
			updatedAt: T,
		}),
	);
}

export async function addEpisode(
	deps: IndexingDeps,
	id: string,
	over: Partial<
		Record<"title" | "situation" | "action" | "outcome" | "lesson", string>
	> = {},
) {
	await deps.store.write((db) =>
		upsertEpisode(db, {
			id,
			title: over.title ?? `episode ${id}`,
			situation: over.situation ?? "situation",
			intent: "",
			decision: "",
			observations: "",
			action: over.action ?? "",
			outcome: over.outcome ?? "outcome",
			lesson: over.lesson ?? "lesson",
			openQuestions: [],
			outcomeKind: "success",
			eventStart: null,
			eventEnd: null,
			timePrecision: "unknown",
			confidence: 0.8,
			importance: 0.5,
			status: "active",
			space: "coding",
			scope: "global",
			repoKey: null,
			facets: {},
			metadata: {},
			createdAt: T,
			updatedAt: T,
		}),
	);
}

export async function putVector(
	deps: IndexingDeps,
	input: {
		ownerKind?: VectorOwnerKind;
		ownerId: string;
		text: string;
		vector?: Float32Array;
		origin?: VectorOrigin;
		verification?: VectorVerification;
		digest?: string;
	},
) {
	await deps.store.write((db) =>
		upsertVector(db, {
			ownerKind: input.ownerKind ?? "knowledge",
			ownerId: input.ownerId,
			spaceKey: deps.spaceKey,
			contentDigest: input.digest ?? sha256Hex(input.text),
			vector: input.vector ?? fakeVector(input.text),
			origin: input.origin ?? "legacy_import",
			verification: input.verification ?? "unverified",
			now: T,
		}),
	);
}

export const busy = (retryAfterMs: number) =>
	new LarmError("larm_busy", retryAfterMs);
