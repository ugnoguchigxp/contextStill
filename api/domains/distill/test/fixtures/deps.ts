import { tempStore } from "../../../../infrastructure/sqlite/test-support";
import { migrations as experience } from "../../../experience";
import {
	migrations as knowledge,
	upsertKnowledgeItem,
	type KnowledgeInput,
} from "../../../knowledge";
import { migrations as map } from "../../../map";
import { createQueue, migrations as queue } from "../../../queue";
import { migrations as sources } from "../../../sources";
import { migrations as usage } from "../../../usage";
import { migrations as vectors } from "../../../vectors";
import type { DistillDeps } from "../../contracts";
import { migrations as distill } from "../../repository";
import { createFakeLlm, type FakeLlm } from "./fake-llm";

export const T0 = "2026-10-30T00:00:00.000Z";

/** Migrations of every domain distill reads or writes, in dependency order. */
export const distillMigrations = [
	...queue,
	...sources,
	...experience,
	...knowledge,
	...vectors,
	...usage,
	...map,
	...distill,
];

export interface TestDistill {
	deps: DistillDeps;
	llm: FakeLlm;
	/** Advance the clock used by `deps.now`. */
	setNow(iso: string): void;
	logs: string[];
	dispose(): Promise<void>;
}

/**
 * A real store in a temporary directory with all migrations, a real (not started) queue, the
 * fake LLM and a fixed clock. `embedKnowledge` reports nothing embedded; replace it per test.
 *
 *   const t = createTestDistill();
 *   afterEach(() => t.dispose());
 */
export function createTestDistill(
	over: Partial<DistillDeps> = {},
): TestDistill {
	const temp = tempStore(distillMigrations);
	const llm = createFakeLlm();
	let now = new Date(T0);
	const logs: string[] = [];
	const deps: DistillDeps = {
		store: temp.store,
		llm,
		queue: createQueue(temp.store),
		spaceKey: "larm-e5-small",
		embedKnowledge: async () => ({
			owner: "knowledge",
			candidates: 0,
			embedded: 0,
			skipped: 0,
			failed: 0,
			busyWaits: 0,
		}),
		now: () => now,
		log: (line) => logs.push(line),
		...over,
	};
	return {
		deps,
		llm,
		logs,
		setNow(iso) {
			now = new Date(iso);
		},
		dispose: temp.dispose,
	};
}

/** An active atom with every required field; override what the test cares about. */
export function atom(
	id: string,
	over: Partial<KnowledgeInput> = {},
): KnowledgeInput {
	return {
		id,
		layer: "atom",
		type: "rule",
		polarity: "positive",
		title: `title ${id}`,
		body: `body ${id}`,
		appliesWhen: [],
		notAppliesWhen: [],
		steps: [],
		facets: {},
		confidence: 0.8,
		importance: 0.5,
		status: "active",
		space: "coding",
		scope: "global",
		repoKey: null,
		validFrom: null,
		validUntil: null,
		provenanceStatus: "resolved",
		metadata: {},
		createdAt: T0,
		updatedAt: T0,
		...over,
	};
}

/** Inserts atoms through the knowledge domain's own upsert. */
export async function seedAtoms(
	deps: Pick<DistillDeps, "store">,
	inputs: KnowledgeInput[],
): Promise<void> {
	await deps.store.write((db) => {
		for (const input of inputs) upsertKnowledgeItem(db, input);
	});
}
