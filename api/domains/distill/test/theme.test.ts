import { afterEach, expect, test } from "bun:test";
import { DistillError } from "../contracts";
import {
	edgesFrom,
	edgesTo,
	getCluster,
	listClusterMembers,
	listClusters,
	themeHandle,
} from "../../map";
import {
	getKnowledgeById,
	upsertKnowledgeItem,
	setKnowledgeDisposition,
} from "../../knowledge";
import type { ChatRequest } from "../../larm";
import type { HandlerDefinition } from "../../queue";
import { ensureVectorSpace, upsertVector } from "../../vectors";
import { createRun, getRun, listReviews } from "../repository";
import { sphericalKMeans } from "../service/theme/kmeans";
import { clusterThemes } from "../service/theme/plan";
import { createTheme } from "../service/theme";
import {
	collectFacetEvidence,
	listActiveCanonicals,
} from "../service/theme/queries";
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

/** The model's page for a theme prompt: named after the first item, the first two as key members. */
function themeReply(text: string) {
	const items = [...text.matchAll(/^\[(a\d+)\] (.*)$/gm)];
	return {
		schemaVersion: 1,
		name: `Theme of ${items[0]![2]}`.slice(0, 40),
		description: "what the theme covers",
		aliases: ["alt name"],
		overview: "overview",
		keyMembers: items.slice(0, 2).map((m) => m[1]),
		cautions: ["a caution"],
		openQuestions: [],
	};
}
const isThemePrompt = (text: string) =>
	text.includes("knowledge page of one theme");

test("k-means gives the same clusters for the same points, whatever the order", async () => {
	const dim = 6;
	const points = Array.from({ length: 60 }, (_, i) => ({
		id: `p${pad(i)}`,
		vector: near(i % 6, i, dim),
	}));
	const run = (list: typeof points, k: number) =>
		sphericalKMeans(
			list.map((p) => p.id),
			list.map((p) => p.vector),
			k,
		);
	const groups = (list: typeof points, r: Awaited<ReturnType<typeof run>>) => {
		const by = new Map<number, string[]>();
		list.forEach((p, i) =>
			(
				by.get(r.assignments[i]!) ??
				by.set(r.assignments[i]!, []).get(r.assignments[i]!)!
			).push(p.id),
		);
		return [...by.values()].map((g) => g.sort().join(",")).sort();
	};
	const a = await run(points, 6);
	const b = await run(points, 6);
	expect(b.assignments).toEqual(a.assignments);
	const shuffled = [...points].sort((x, y) => (x.id < y.id ? 1 : -1));
	const c = await run(shuffled, 6);
	expect(groups(shuffled, c)).toEqual(groups(points, a));
	// The six axes are found, one cluster each.
	expect(a.centers).toHaveLength(6);
	for (const members of groups(points, a))
		expect(
			new Set(members.split(",").map((id) => Number(id.slice(1)) % 6)).size,
		).toBe(1);
	// k is limited to the number of points; nothing is empty.
	const few = await run(points.slice(0, 3), 10);
	expect(few.centers).toHaveLength(3);
	expect(new Set(few.assignments).size).toBe(3);
});

test("clusterThemes makes two levels: k2 = round(N/25) narrow, k1 = round(k2/8) broad", async () => {
	const dim = 12;
	const points = Array.from({ length: 300 }, (_, i) => ({
		id: `c${pad(i)}`,
		contentDigest: "d",
		vector: near(i % 12, i, dim),
	}));
	const raw = await clusterThemes(points);
	expect(raw.k2).toBe(12);
	expect(raw.k1).toBe(2); // round(12/8) = 2
	const broad = raw.themes.filter((t) => t.level === 1);
	const narrow = raw.themes.filter((t) => t.level === 2);
	expect(broad).toHaveLength(2);
	expect(narrow).toHaveLength(12);
	for (const n of narrow) {
		expect(n.parent).not.toBeNull();
		expect(raw.themes[n.parent!]!.level).toBe(1);
	}
	// Every canonical is in exactly one narrow theme, and a broad theme holds its children's.
	expect(narrow.flatMap((n) => n.members.map((m) => m.id)).sort()).toEqual(
		points.map((p) => p.id),
	);
	for (const [index, b] of raw.themes.entries()) {
		if (b.level !== 1) continue;
		const children = narrow
			.filter((n) => n.parent === index)
			.flatMap((n) => n.members.map((m) => m.id));
		expect(b.members.map((m) => m.id).sort()).toEqual(children.sort());
	}
	expect(await clusterThemes(points)).toEqual(raw);
});

test("start builds the themes, about and broader edges, then the jobs write the pages", async () => {
	const { t, handlers } = setup();
	await space(t, 4);
	await seedCanonicals(t, 100, (i) => i % 4);
	t.llm.fallback = (req: ChatRequest) => themeReply(messageText(req));
	const module = createTheme(t.deps);
	module.registerHandlers();
	const runId = await startRun(t, "run_1");

	const enqueued = await module.start("theme", runId, { dryRun: false });
	expect(enqueued).toBe(5); // four narrow themes and one broad

	const clusters = t.deps.store.read((db) =>
		listClusters(db, { kind: "theme" }),
	);
	const narrow = clusters.filter((c) => c.level === 2);
	const broad = clusters.filter((c) => c.level === 1);
	expect(narrow).toHaveLength(4);
	expect(broad).toHaveLength(1);
	for (const c of narrow) {
		expect(c.handle).toBe(themeHandle(c.id));
		expect(c.handle).toMatch(/^th_[a-z2-7]{26}$/);
		expect(c.parentId).toBe(broad[0]!.id);
		expect(c.state).toBe("pending");
	}
	t.deps.store.read((db) => {
		// 25 canonicals per narrow theme, 20 of them core; the broad theme holds all 100.
		for (const c of narrow) {
			const members = listClusterMembers(db, c.id);
			expect(members).toHaveLength(25);
			expect(members.filter((m) => m.role === "core")).toHaveLength(20);
			expect(new Set(members.map((m) => Number(m.id.slice(1)) % 4)).size).toBe(
				1,
			);
		}
		expect(listClusterMembers(db, broad[0]!.id)).toHaveLength(100);
		// about: canonical to its narrow theme (origin clustering); broader: narrow to broad.
		for (const c of narrow) {
			const about = edgesTo(db, "theme", c.id, "about");
			expect(about).toHaveLength(25);
			expect(
				about.every((e) => e.origin === "clustering" && e.status === "active"),
			).toBe(true);
			const up = edgesFrom(db, "theme", c.id, "broader");
			expect(up.map((e) => e.dst.id)).toEqual([broad[0]!.id]);
		}
		expect(edgesFrom(db, "knowledge", "c000", "about")).toHaveLength(1);
	});

	expect(await drive(t, handlers)).toBe(5);
	t.deps.store.read((db) => {
		for (const c of listClusters(db, { kind: "theme" })) {
			expect(c.state).toBe("distilled");
			expect(c.name).toMatch(/^Theme of title c/);
			expect(c.aliases).toEqual(["alt name"]);
			const summary = c.summary as { keyMembers: string[]; overview: string };
			expect(summary.overview).toBe("overview");
			expect(summary.keyMembers).toHaveLength(2);
			const members = new Set(listClusterMembers(db, c.id).map((m) => m.id));
			for (const id of summary.keyMembers) expect(members.has(id)).toBe(true);
		}
		const run = getRun(db, runId)!;
		expect(run.state).toBe("completed");
		expect(run.counts).toMatchObject({
			planned: 5,
			settled: 5,
			distilled: 5,
			themes: 5,
		});
	});
	// The model is shown at most 20 items per theme, under aliases.
	const themeCalls = t.llm.calls.filter((c) => isThemePrompt(messageText(c)));
	expect(themeCalls).toHaveLength(5);
	for (const call of themeCalls) {
		expect(messageText(call)).toContain("[a1] ");
		expect(messageText(call)).not.toContain("[a21]");
	}
});

test("key members that are not members of the theme are rejected after one correction", async () => {
	const { t, handlers } = setup();
	await space(t, 4);
	await seedCanonicals(t, 25, () => 0);
	const wrong = { ...themeReply("[a1] x\n[a2] y"), keyMembers: ["a1", "a99"] };
	// Both answers name a99 (the theme has 20 items shown, a1..a20): rejected.
	t.llm.fallback = () => wrong;
	const module = createTheme(t.deps);
	module.registerHandlers();
	const runId = await startRun(t, "run_1");
	await module.start("theme", runId, { dryRun: false });
	await drive(t, handlers);
	expect(t.llm.calls).toHaveLength(2 * 2); // one correction for each of the two themes
	t.deps.store.read((db) => {
		const clusters = listClusters(db, { kind: "theme" });
		expect(clusters.map((c) => c.state)).toEqual(["review", "review"]);
		const reviews = listReviews(db, "open");
		expect(reviews).toHaveLength(2);
		expect(reviews[0]!.kind).toBe("host_rejected");
		expect(reviews[0]!.subject).toMatchObject({
			stage: "theme",
			reason: "host_check",
		});
		expect(JSON.stringify(reviews[0]!.subject)).toContain("a99");
		expect(getRun(db, runId)!.state).toBe("completed");
	});
});

test("one correction is enough when the second answer passes", async () => {
	const { t, handlers } = setup();
	await space(t, 4);
	await seedCanonicals(t, 25, () => 0);
	const good = (req: Parameters<typeof messageText>[0]) =>
		themeReply(messageText(req));
	t.llm.fallback = (req: ChatRequest) =>
		messageText(req).includes("rejected by the checks")
			? good(req)
			: { ...good(req), keyMembers: ["a1", "a77"] };
	// The first round fails the host check (a77); the host's correction returns the good page.
	const module = createTheme(t.deps);
	module.registerHandlers();
	const runId = await startRun(t, "run_1");
	await module.start("theme", runId, { dryRun: false });
	await drive(t, handlers);
	t.deps.store.read((db) => {
		for (const c of listClusters(db, { kind: "theme" }))
			expect(c.state).toBe("distilled");
		expect(listReviews(db, "open")).toHaveLength(0);
	});
});

test("a theme page that names a repository is rejected", async () => {
	const { t, handlers } = setup();
	await space(t, 4);
	await seedCanonicals(
		t,
		25,
		() => 0,
		4,
		() => ({}),
	);
	// A repo key of another row makes "nightworkers" a repo term.
	await t.deps.store.write((db) =>
		upsertKnowledgeItem(
			db,
			atom("atom-1", { scope: "repo", repoKey: "nightworkers" }),
		),
	);
	t.llm.fallback = (req: ChatRequest) => ({
		...themeReply(messageText(req)),
		description: "how nightworkers handles queues in src/jobs/run.ts",
	});
	const module = createTheme(t.deps);
	module.registerHandlers();
	const runId = await startRun(t, "run_1");
	await module.start("theme", runId, { dryRun: false });
	await drive(t, handlers);
	t.deps.store.read((db) => {
		for (const c of listClusters(db, { kind: "theme" }))
			expect(c.state).toBe("review");
		const findings = listReviews(db, "open").flatMap(
			(r) => (r.subject as { findings: string[] }).findings,
		);
		expect(findings).toContain("description: repo_term nightworkers");
		expect(findings).toContain("description: relative_path src/jobs/run.ts");
	});
});

test("a theme that keeps at least half of its members keeps its id and handle", async () => {
	const { t, handlers } = setup();
	await space(t, 4);
	await seedCanonicals(t, 100, (i) => i % 4);
	t.llm.fallback = (req: ChatRequest) => themeReply(messageText(req));
	const module = createTheme(t.deps);
	module.registerHandlers();
	await module.start("theme", await startRun(t, "run_1"), { dryRun: false });
	await drive(t, handlers);
	const before = t.deps.store.read((db) => listClusters(db, { kind: "theme" }));
	const byMember = (list: typeof before, id: string) =>
		list.find(
			(c) =>
				c.level === 2 &&
				t.deps.store
					.read((db) => listClusterMembers(db, c.id))
					.some((m) => m.id === id),
		)!;
	const g0 = byMember(before, "c000");
	const g1 = byMember(before, "c001");
	const g3 = byMember(before, "c003");

	// Group 0 gains five canonicals (Jaccard 25/30), group 3 is retracted, groups 1 and 2 stay.
	await seedCanonicals(
		t,
		5,
		() => 0,
		4,
		() => ({}),
		100,
	);
	await t.deps.store.write((db) => {
		for (let i = 0; i < 100; i++)
			if (i % 4 === 3)
				setKnowledgeDisposition(db, `c${pad(i)}`, {
					status: "retracted",
					updatedAt: T0,
				});
	});
	t.setNow("2026-10-31T00:00:00.000Z");
	const enqueued = await module.start("theme", await startRun(t, "run_2"), {
		dryRun: false,
	});

	const after = t.deps.store.read((db) => listClusters(db, { kind: "theme" }));
	const live = after.filter((c) => c.state !== "stale" || c.level === 1);
	t.deps.store.read((db) => {
		const g0After = getCluster(db, g0.id)!;
		expect(g0After.handle).toBe(g0.handle);
		expect(g0After.state).toBe("stale"); // members changed: the page is written again
		expect(g0After.name).toBe(g0.name); // and shown until then
		expect(listClusterMembers(db, g0.id)).toHaveLength(30);
		// Unchanged themes are not touched and need no job.
		const g1After = getCluster(db, g1.id)!;
		expect(g1After.state).toBe("distilled");
		expect(g1After.name).toBe(g1.name);
		expect(listClusterMembers(db, g1.id)).toHaveLength(25);
		// The vanished theme is emptied, marked stale and its edges retracted.
		const g3After = getCluster(db, g3.id)!;
		expect(g3After.state).toBe("stale");
		expect(listClusterMembers(db, g3.id)).toHaveLength(0);
		expect(
			edgesTo(db, "theme", g3.id, "about").every(
				(e) => e.status === "retracted",
			),
		).toBe(true);
		expect(
			edgesFrom(db, "knowledge", "c003", "about").every(
				(e) => e.status === "retracted",
			),
		).toBe(true);
		expect(edgesFrom(db, "knowledge", "c100", "about")[0]!.dst.id).toBe(g0.id);
	});
	expect(live.filter((c) => c.level === 2 && c.state !== "stale")).toHaveLength(
		2,
	);
	// Jobs: the changed narrow theme and the broad theme (its members changed too).
	expect(enqueued).toBe(2);
});

test("a dry run reports the jobs and writes nothing", async () => {
	const { t } = setup();
	await space(t, 4);
	await seedCanonicals(t, 50, (i) => i % 2);
	const module = createTheme(t.deps);
	module.registerHandlers();
	const n = await module.start("theme", await startRun(t, "run_1"), {
		dryRun: true,
	});
	expect(n).toBe(3); // two narrow themes and one broad
	expect(t.deps.store.read((db) => listClusters(db))).toHaveLength(0);
	// limit caps the jobs
	const limited = await module.start("theme", "run_1", {
		dryRun: true,
		limit: 1,
	});
	expect(limited).toBe(1);
});

test("vectors that are not verified stop the stage unless a pilot run allows them", async () => {
	const { t } = setup();
	await space(t, 4);
	await seedCanonicals(t, 25, () => 0);
	await t.deps.store.write((db) => {
		for (let i = 0; i < 25; i++)
			upsertVector(db, {
				ownerKind: "knowledge",
				ownerId: `c${pad(i)}`,
				spaceKey: t.deps.spaceKey,
				contentDigest: getKnowledgeById(db, `c${pad(i)}`)!.contentDigest,
				vector: near(0, i, 4),
				origin: "legacy_import",
				verification: "unverified",
				now: T0,
			});
	});
	const module = createTheme(t.deps);
	module.registerHandlers();
	await expect(
		module.start("theme", await startRun(t, "run_1"), { dryRun: false }),
	).rejects.toMatchObject({ code: "distill_vectors_unverified" });
	await expect(
		module.start("examples" as never, "run_1", { dryRun: true }),
	).rejects.toBeInstanceOf(DistillError);
	const n = await module.start("theme", "run_1", {
		dryRun: false,
		allowUnverified: true,
	});
	expect(n).toBe(2);
	const algorithms = t.deps.store
		.read((db) => listClusters(db, { kind: "theme" }))
		.map((c) => c.algorithm);
	expect(algorithms.every((a) => a.endsWith("|unverified"))).toBe(true);
});

test("no canonical means no job", async () => {
	const { t } = setup();
	await space(t, 4);
	const module = createTheme(t.deps);
	module.registerHandlers();
	expect(
		await module.start("theme", await startRun(t, "run_1"), { dryRun: false }),
	).toBe(0);
});

test("personal canonicals and the facets of personal atoms are not input of the theme stage", async () => {
	const { t } = setup();
	await space(t, 4);
	await seedCanonicals(
		t,
		4,
		(i) => i,
		4,
		(i) => (i === 0 ? { space: "personal" } : {}),
	);
	await t.deps.store.write((db) => {
		upsertKnowledgeItem(db, atom("a-ok", { facets: { domains: ["queue"] } }));
		upsertKnowledgeItem(
			db,
			atom("a-personal", {
				space: "personal",
				facets: { domains: ["diary"] },
			}),
		);
	});
	t.deps.store.read((db) => {
		expect(listActiveCanonicals(db).map((c) => c.id)).toEqual([
			"c001",
			"c002",
			"c003",
		]);
		const domains = collectFacetEvidence(db).get("domains")!;
		expect([...domains.keys()]).toEqual(["queue"]);
	});
});
