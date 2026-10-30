import { afterEach, expect, test } from "bun:test";
import {
	getFacetConcept,
	listClusters,
	listFacetConcepts,
	upsertFacetConcept,
} from "../../map";
import {
	getKnowledgeById,
	replaceKnowledgeEvidence,
	upsertKnowledgeItem,
} from "../../knowledge";
import type { ChatRequest } from "../../larm";
import type { HandlerDefinition } from "../../queue";
import { ensureVectorSpace, upsertVector } from "../../vectors";
import { createRun, getRun, listReviews } from "../repository";
import { createTheme } from "../service/theme";
import { decideFacets, planFacetBatches } from "../service/theme/facets";
import {
	atom,
	createTestDistill,
	messageText,
	T0,
	type TestDistill,
} from "./fixtures";

const ts: TestDistill[] = [];
afterEach(async () => {
	for (const t of ts.splice(0)) await t.dispose();
});

type AnyHandler = HandlerDefinition<unknown, unknown, unknown>;
const pad = (i: number) => String(i).padStart(3, "0");
/** A small deterministic disturbance in [-0.5, 0.5). */
const noise = (i: number, d: number) => ((i * 31 + d * 17) % 13) / 13 - 0.5;
const unit = (v: number[]) => {
	const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
	return Float32Array.from(v.map((x) => x / n));
};
/** A point near the axis `group` of a `dim`-dimensional space. */
const near = (group: number, i: number, dim: number) =>
	unit(
		Array.from(
			{ length: dim },
			(_, d) => (d === group ? 1 : 0) + 0.08 * noise(i, d),
		),
	);

function setup() {
	const t = createTestDistill();
	ts.push(t);
	const handlers = new Map<string, AnyHandler>();
	const real = t.deps.queue;
	t.deps.queue = {
		...real,
		registerHandler<P, I, O>(h: HandlerDefinition<P, I, O>) {
			handlers.set(h.kind, h as unknown as AnyHandler);
			real.registerHandler(h);
		},
	};
	return { t, handlers };
}

async function space(t: TestDistill, dimension: number) {
	await t.deps.store.write((db) => {
		t.deps.spaceKey = ensureVectorSpace(
			db,
			{ model: { id: "m", revision: "r", artifactDigest: "d" }, dimension },
			T0,
		);
	});
}

/** Canonicals c000.. with a vector near the axis group(i). */
async function seedCanonicals(
	t: TestDistill,
	count: number,
	group: (i: number) => number,
	dim = 4,
	over: (i: number) => Parameters<typeof atom>[1] = () => ({}),
	from = 0,
) {
	await t.deps.store.write((db) => {
		for (let i = from; i < from + count; i++) {
			const id = `c${pad(i)}`;
			upsertKnowledgeItem(
				db,
				atom(id, {
					layer: "canonical",
					title: `title ${id}`,
					situation: `situation ${id}`,
					body: `guidance ${id}`,
					...over(i),
				}),
			);
			upsertVector(db, {
				ownerKind: "knowledge",
				ownerId: id,
				spaceKey: t.deps.spaceKey,
				contentDigest: getKnowledgeById(db, id)!.contentDigest,
				vector: near(group(i), i, dim),
				origin: "larm",
				verification: "verified",
				now: T0,
			});
		}
	});
}

/** Runs every queued job of the queue by hand, in order; the real runner is never started. */
async function drive(
	t: TestDistill,
	handlers: Map<string, AnyHandler>,
	options: { limit?: number } = {},
) {
	const done = new Set<string>();
	let runs = 0;
	for (;;) {
		const queued = [];
		let cursor: string | null = null;
		do {
			const page = t.deps.queue.list(
				{ scope: "distill", state: "queued" },
				cursor,
				100,
			);
			queued.push(...page.items.filter((j) => !done.has(j.id)));
			cursor = page.nextCursor;
		} while (cursor);
		if (queued.length === 0 || runs >= (options.limit ?? 10_000)) return runs;
		for (const dto of queued) {
			done.add(dto.id);
			runs++;
			const job = t.deps.queue.get(dto.id)!;
			const handler = handlers.get(job.kind)!;
			const claim = {
				jobId: job.id,
				scope: job.scope,
				kind: job.kind,
				payloadVersion: job.payloadVersion,
				payload: JSON.parse(job.payloadJson) as unknown,
				subjectRef: job.subjectRef,
				owner: "test",
				attempt: 1,
				generation: 0,
				maxAttempts: 3,
				deadlineAtMs: null,
			};
			const prepared = await t.deps.store.write((db) =>
				handler.prepareInTransaction(db, claim),
			);
			if (prepared.status === "stale") continue;
			let outcome:
				| { type: "success"; result: unknown }
				| { type: "failed"; errorCode: string };
			try {
				outcome = {
					type: "success",
					result: await handler.execute(prepared.input, {
						signal: new AbortController().signal,
						jobId: job.id,
						attempt: 1,
						generation: 0,
					}),
				};
			} catch (error) {
				outcome = { type: "failed", errorCode: (error as Error).message };
			}
			await t.deps.store.write((db) =>
				handler.settleInTransaction(db, claim, prepared.input, outcome),
			);
		}
	}
}

const startRun = async (t: TestDistill, id: string, stage = "theme") => {
	await t.deps.store.write((db) =>
		createRun(db, { id, stage: stage as "theme", params: {}, at: T0 }),
	);
	return id;
};

const isFacetPrompt = (text: string) => text.includes("normalise the tags");
const isThemePrompt = (text: string) =>
	text.includes("knowledge page of one theme");

/** A page for a theme prompt, and for a facet prompt one concept per value. */
function reply(text: string) {
	if (isFacetPrompt(text)) {
		const values = [...text.matchAll(/^(\d+): (.*)$/gm)];
		return {
			schemaVersion: 1,
			concepts: values.map((m) => ({
				name: `concept ${m[2]}`.slice(0, 40),
				values: [Number(m[1])],
			})),
		};
	}
	const items = [...text.matchAll(/^\[(a\d+)\] (.*)$/gm)];
	return {
		schemaVersion: 1,
		name: `Theme of ${items[0]![2]}`.slice(0, 40),
		description: "d",
		aliases: [],
		overview: "o",
		keyMembers: [items[0]![1]],
		cautions: [],
		openQuestions: [],
	};
}

/**
 * 100 canonicals in four groups (themes). Atom `a-<i>` was absorbed into canonical c<i>; its
 * facets are given by `facets(i)`. Atoms `loose-<n>` were absorbed into nothing.
 */
async function seedWorld(
	t: TestDistill,
	facets: (i: number) => Record<string, string[]>,
	loose: Record<string, string[]>[] = [],
) {
	await seedCanonicals(t, 100, (i) => i % 4);
	await t.deps.store.write((db) => {
		for (let i = 0; i < 100; i++) {
			const atomId = `a-${pad(i)}`;
			upsertKnowledgeItem(
				db,
				atom(atomId, { status: "superseded", facets: facets(i) }),
			);
			replaceKnowledgeEvidence(
				db,
				`c${pad(i)}`,
				"pipeline",
				[
					{
						targetKind: "atom",
						targetId: atomId,
						externalRef: null,
						role: "derived_from",
						quote: null,
						confidence: null,
					},
				],
				T0,
			);
		}
		loose.forEach((facet, n) =>
			upsertKnowledgeItem(db, atom(`loose-${pad(n)}`, { facets: facet })),
		);
	});
}

test("a value goes to the theme of the canonicals its atoms were absorbed into, when most agree", () => {
	const evidence = new Map([
		[
			"domains" as const,
			new Map([
				["frontend", ["c1", "c2", "c3"]], // three of three in theme A
				["testing", ["c1", "c4"]], // one each: no majority
				["mostly", ["c1", "c2", "c4"]], // two of three in A
				["orphan", []], // nothing absorbed
				["outside", ["gone"]], // absorbed into a canonical that has no theme
			]),
		],
		["technologies" as const, new Map([["ts", ["c4", "c4"]]])],
		["changeTypes" as const, new Map()],
	]);
	const themeOf = new Map([
		["c1", "A"],
		["c2", "A"],
		["c3", "A"],
		["c4", "B"],
	]);
	const { mapped, undecided } = decideFacets(evidence, themeOf);
	expect(
		mapped.map((m) => [m.facetKey, m.rawValue, m.themeId, m.votes, m.total]),
	).toEqual([
		["domains", "frontend", "A", 3, 3],
		["domains", "mostly", "A", 2, 3],
		["technologies", "ts", "B", 2, 2],
	]);
	expect(undecided.map((u) => u.rawValue)).toEqual([
		"testing",
		"orphan",
		"outside",
	]);
});

test("values with no majority are batched by 50 for the model; owner and earlier model mappings are kept", async () => {
	const { t } = setup();
	await space(t, 4);
	const many = Array.from({ length: 120 }, (_, n) => `tech-${pad(n)}`);
	const undecided = [
		...many.map((v) => ({ facetKey: "technologies" as const, rawValue: v })),
		{ facetKey: "domains" as const, rawValue: "kept-by-owner" },
		{ facetKey: "domains" as const, rawValue: "asked-before" },
		{ facetKey: "domains" as const, rawValue: "stale-deterministic" },
		{ facetKey: "domains" as const, rawValue: "x".repeat(81) },
	];
	await t.deps.store.write((db) => {
		for (const [rawValue, origin] of [
			["kept-by-owner", "human"],
			["asked-before", "llm"],
			["stale-deterministic", "deterministic"],
		] as const)
			upsertFacetConcept(db, {
				facetKey: "domains",
				rawValue,
				concept: "c",
				themeId: null,
				origin,
				at: T0,
			});
	});
	const { batches, skipped } = t.deps.store.read((db) =>
		planFacetBatches(db, undecided),
	);
	expect(batches.map((b) => [b.key, b.values.length])).toEqual([
		["domains", 1],
		["technologies", 50],
		["technologies", 50],
		["technologies", 20],
	]);
	expect(batches[0]!.values).toEqual(["stale-deterministic"]);
	expect(skipped).toBe(3); // the owner's, the earlier model's, and the sentence
});

test("start maps facet values to themes (deterministic) and sends the rest to the model", async () => {
	const { t, handlers } = setup();
	await space(t, 4);
	await seedWorld(
		t,
		(i) => ({
			// "UI " normalises to "ui"; every atom of group 0 has it.
			domains: i % 4 === 0 ? ["UI ", "shared"] : ["shared"],
			technologies: i % 4 === 1 ? ["TypeScript"] : [],
			changeTypes: [],
		}),
		[{ domains: ["lonely"] }, { technologies: ["Lonely Tech", "ts"] }],
	);
	t.llm.fallback = (req: ChatRequest) => reply(messageText(req));
	const module = createTheme(t.deps);
	module.registerHandlers();
	const runId = await startRun(t, "run_1");
	const enqueued = await module.start("theme", runId, { dryRun: false });

	// 5 theme jobs and 2 facet batches: domains (shared, lonely) and technologies (lonely tech, ts).
	// "shared" has atoms in all four groups, 25 each: no majority. "ui" and "typescript" have one.
	expect(enqueued).toBe(5 + 2);
	t.deps.store.read((db) => {
		const themes = listClusters(db, { kind: "theme", parentId: undefined });
		const ui = getFacetConcept(db, "domains", "ui")!;
		expect(ui).toMatchObject({ origin: "deterministic", concept: "ui" });
		const typescript = getFacetConcept(db, "technologies", "typescript")!;
		expect(typescript.origin).toBe("deterministic");
		expect(ui.themeId).not.toBe(typescript.themeId);
		for (const row of [ui, typescript])
			expect(themes.find((c) => c.id === row.themeId)!.level).toBe(2);
		expect(getFacetConcept(db, "domains", "shared")).toBeNull();
		expect(getRun(db, runId)!.counts).toMatchObject({
			planned: 7,
			facetsDeterministic: 2,
		});
	});

	await drive(t, handlers);
	t.deps.store.read((db) => {
		const rows = listFacetConcepts(db);
		const byValue = new Map(
			rows.map((r) => [`${r.facetKey}/${r.rawValue}`, r]),
		);
		for (const key of [
			"domains/shared",
			"domains/lonely",
			"technologies/lonely tech",
			"technologies/ts",
		]) {
			const row = byValue.get(key)!;
			expect(row.origin).toBe("llm");
			expect(row.themeId).toBeNull();
			expect(row.concept).toMatch(/^concept /);
		}
		const run = getRun(db, runId)!;
		expect(run.state).toBe("completed");
		expect(run.counts).toMatchObject({ settled: 7, facetsMapped: 4 });
	});
	const facetCalls = t.llm.calls.filter((c) => isFacetPrompt(messageText(c)));
	expect(facetCalls).toHaveLength(2);
	expect(t.llm.calls.filter((c) => isThemePrompt(messageText(c)))).toHaveLength(
		5,
	);

	// Run again: the values the model already answered are not asked, the deterministic ones stay.
	t.llm.calls.length = 0;
	const again = await module.start("theme", await startRun(t, "run_2"), {
		dryRun: false,
	});
	expect(again).toBe(0);
	expect(t.llm.calls).toHaveLength(0);
});

test("a concept name that carries a repository name is rejected, and nothing is stored", async () => {
	const { t, handlers } = setup();
	await space(t, 4);
	await seedWorld(t, () => ({}), [{ domains: ["billing"] }]);
	await t.deps.store.write((db) =>
		upsertKnowledgeItem(
			db,
			atom("repo-atom", { scope: "repo", repoKey: "nightworkers" }),
		),
	);
	t.llm.fallback = (req: ChatRequest) => {
		const text = messageText(req);
		const r = reply(text);
		if (!isFacetPrompt(text)) return r;
		return {
			schemaVersion: 1,
			concepts: [{ name: "nightworkers billing", values: [0] }],
		};
	};
	const module = createTheme(t.deps);
	module.registerHandlers();
	const runId = await startRun(t, "run_1");
	await module.start("theme", runId, { dryRun: false });
	await drive(t, handlers);
	t.deps.store.read((db) => {
		expect(getFacetConcept(db, "domains", "billing")).toBeNull();
		const reviews = listReviews(db, "open");
		expect(reviews).toHaveLength(1);
		expect(reviews[0]!.subject).toMatchObject({
			stage: "theme",
			facetKey: "domains",
			reason: "host_check",
		});
		expect(getRun(db, runId)!.state).toBe("completed");
	});
	// The value was asked once, corrected once.
	expect(t.llm.calls.filter((c) => isFacetPrompt(messageText(c)))).toHaveLength(
		2,
	);
});

test("an index the model invents, or uses twice, is a host rejection", async () => {
	const { t, handlers } = setup();
	await space(t, 4);
	await seedWorld(t, () => ({}), [{ domains: ["one", "two"] }]);
	t.llm.fallback = (req: ChatRequest) => {
		const text = messageText(req);
		if (!isFacetPrompt(text)) return reply(text);
		return {
			schemaVersion: 1,
			concepts: [
				{ name: "a", values: [0, 5] },
				{ name: "b", values: [0] },
			],
		};
	};
	const module = createTheme(t.deps);
	module.registerHandlers();
	await module.start("theme", await startRun(t, "run_1"), { dryRun: false });
	await drive(t, handlers);
	t.deps.store.read((db) => {
		expect(listFacetConcepts(db)).toHaveLength(0);
		const findings = (
			listReviews(db, "open")[0]!.subject as { findings: string[] }
		).findings;
		expect(findings).toEqual([
			"concept 0: index 5 is not in the list",
			"concept 1: index 0 is used twice",
		]);
	});
});

test("an owner's mapping is never replaced by the stage", async () => {
	const { t, handlers } = setup();
	await space(t, 4);
	await seedWorld(t, (i): Record<string, string[]> =>
		i % 4 === 0 ? { domains: ["ui"] } : {},
	);
	await t.deps.store.write((db) =>
		upsertFacetConcept(db, {
			facetKey: "domains",
			rawValue: "ui",
			concept: "owner choice",
			themeId: null,
			origin: "human",
			at: T0,
		}),
	);
	t.llm.fallback = (req: ChatRequest) => reply(messageText(req));
	const module = createTheme(t.deps);
	module.registerHandlers();
	await module.start("theme", await startRun(t, "run_1"), { dryRun: false });
	await drive(t, handlers);
	const row = t.deps.store.read((db) => getFacetConcept(db, "domains", "ui"))!;
	expect(row).toMatchObject({ origin: "human", concept: "owner choice" });
});
