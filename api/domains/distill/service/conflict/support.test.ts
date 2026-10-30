/**
 * Fixtures for the tests of conflict, review and audit (not production code): canonicals with
 * atoms, evidence, usage and 3-dimensional vectors in a temporary database, and a helper that
 * runs the queue until it is empty. Only test files import this.
 */
import { z } from "zod";
import { vectorSpaceKey } from "../../../../infrastructure/vector";
import {
	knowledgeContentDigest,
	replaceKnowledgeEvidence,
	setKnowledgeDisposition,
	upsertKnowledgeItem,
	type KnowledgeInput,
} from "../../../knowledge";
import { insertUsageEvent } from "../../../usage";
import { ensureVectorSpace, upsertVector } from "../../../vectors";
import type { DistillDeps } from "../../contracts";
import { createRun } from "../../repository";
import {
	atom,
	createTestDistill,
	T0,
	type TestDistill,
} from "../../test/fixtures";

export const DIM = 3;
export const SPACE_KEY = vectorSpaceKey({
	modelId: "test-model",
	revision: "1",
	artifactDigest: "test-artifact",
	dimension: DIM,
});

export function unit(x: number, y: number, z0: number): Float32Array {
	const n = Math.hypot(x, y, z0);
	return Float32Array.from([x / n, y / n, z0 / n]);
}

export interface World extends TestDistill {
	deps: DistillDeps;
}

export async function world(over: Partial<DistillDeps> = {}): Promise<World> {
	const t = createTestDistill({ spaceKey: SPACE_KEY, ...over });
	await t.deps.store.write((db) => {
		ensureVectorSpace(
			db,
			{
				model: {
					id: "test-model",
					revision: "1",
					artifactDigest: "test-artifact",
				},
				dimension: DIM,
			},
			T0,
		);
	});
	return t;
}

export interface CanonicalSeed {
	id: string;
	/** Embedding; null leaves the canonical without a vector. */
	vec?: Float32Array | null;
	atoms?: number;
	/** Distinct raw records per atom (default: one source per atom). */
	records?: number;
	/** `used` events on the atoms. */
	used?: number;
	atomCreatedAt?: string;
	sourceMissing?: boolean;
	clusterId?: string;
	over?: Partial<KnowledgeInput>;
	/** Status of the atoms (default superseded, as after the canonical stage). */
	atomStatus?: "active" | "superseded";
}

let usageSeq = 0;

/** Writes a canonical, its atoms (superseded, evidence_only), evidence rows and vector. */
export async function canonical(
	deps: DistillDeps,
	seed: CanonicalSeed,
): Promise<string[]> {
	const atomIds = Array.from(
		{ length: seed.atoms ?? 2 },
		(_, i) => `${seed.id}-a${i + 1}`,
	);
	await deps.store.write((db) => {
		const title = `title ${seed.id}`;
		const body = `body ${seed.id}`;
		const situation = `situation ${seed.id}`;
		upsertKnowledgeItem(db, {
			...atom(seed.id, {
				layer: "canonical",
				title,
				body,
				situation,
				rationale: "",
				importance: 0.5,
				...(seed.clusterId
					? { metadata: { distill: { clusterId: seed.clusterId } } }
					: {}),
				...seed.over,
			}),
		});
		for (const atomId of atomIds) {
			upsertKnowledgeItem(
				db,
				atom(atomId, {
					title: `atom title ${atomId}`,
					body: `atom body ${atomId}`,
					createdAt: seed.atomCreatedAt ?? T0,
					updatedAt: seed.atomCreatedAt ?? T0,
					provenanceStatus: seed.sourceMissing ? "source_missing" : "resolved",
				}),
			);
			if (seed.atomStatus !== "active")
				setKnowledgeDisposition(db, atomId, {
					status: "superseded",
					retrieval: "evidence_only",
					updatedAt: T0,
				});
			const records = seed.records ?? 1;
			replaceKnowledgeEvidence(
				db,
				atomId,
				"legacy_import",
				seed.sourceMissing
					? []
					: Array.from({ length: records }, (_, i) => ({
							targetKind: "source" as const,
							targetId: `src-${atomId}-${i}`,
							externalRef: null,
							role: "derived_from" as const,
							quote: null,
							confidence: null,
						})),
				T0,
			);
		}
		replaceKnowledgeEvidence(
			db,
			seed.id,
			"pipeline",
			atomIds.map((a) => ({
				targetKind: "atom" as const,
				targetId: a,
				externalRef: null,
				role: "derived_from" as const,
				quote: null,
				confidence: null,
			})),
			T0,
		);
		for (let i = 0; i < (seed.used ?? 0); i++)
			insertUsageEvent(db, {
				id: `u-${++usageSeq}`,
				ownerKind: "knowledge",
				ownerId: atomIds[0] ?? seed.id,
				channel: "search",
				verdict: "used",
				actor: "agent",
				runRef: null,
				reason: null,
				origin: "live",
				occurredAt: T0,
				metadata: {},
			});
		if (seed.vec !== null) {
			upsertVector(db, {
				ownerKind: "knowledge",
				ownerId: seed.id,
				spaceKey: SPACE_KEY,
				contentDigest: knowledgeContentDigest(title, body, situation),
				vector: seed.vec ?? unit(1, 0, 0),
				origin: "larm",
				verification: "verified",
				now: T0,
			});
		}
	});
	return atomIds;
}

export async function newRun(
	deps: DistillDeps,
	id = "run_t1",
	stage = "conflict",
) {
	await deps.store.write((db) =>
		createRun(db, { id, stage: stage as never, params: {}, at: T0 }),
	);
	return id;
}

/** Registers a stand-in for a handler of another stage so that its jobs can be enqueued. */
export function registerStub(deps: DistillDeps, kind: string): void {
	deps.queue.registerHandler({
		kind,
		payloadVersions: [1],
		schema: z.object({}).passthrough(),
		recovery: "replay_safe",
		prepareInTransaction: () => ({ status: "stale", reason: "stub" }),
		execute: async () => null,
		settleInTransaction: () => "applied",
		cancelInTransaction: () => {},
	});
}

/** Runs the queue until it has no open job (jobs spawn jobs). */
export async function drain(deps: DistillDeps, rounds = 200): Promise<void> {
	for (let i = 0; i < rounds; i++) {
		await deps.queue.tick();
		await new Promise((r) => setTimeout(r, 4));
		if (deps.queue.stats().openJobs === 0) return;
	}
	throw new Error("queue_did_not_drain");
}

export const isJudgePrompt = (req: { messages: { content: string }[] }) =>
	req.messages.some((m) => m.content.includes("### Pair 0"));
export const isVerifyPrompt = (req: { messages: { content: string }[] }) =>
	req.messages.some((m) => m.content.includes("CONDITIONS TO ADD"));
