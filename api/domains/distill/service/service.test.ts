import { afterEach, expect, test } from "bun:test";
import { DistillError, type StageModule } from "../contracts";
import { findRunningRun, listRuns } from "../repository";
import { createTestDistill } from "../test/fixtures";
import { createDistill } from "./index";

const ts: ReturnType<typeof createTestDistill>[] = [];
afterEach(async () => {
	for (const t of ts.splice(0)) await t.dispose();
});
const setup = () => {
	const t = createTestDistill();
	ts.push(t);
	return t;
};

test("the real modules register their handlers and answer on an empty database", async () => {
	const t = setup();
	const service = createDistill(t.deps);
	expect(() => service.registerHandlers()).not.toThrow();
	expect(service.listReviews("open")).toEqual([]);
	expect(await service.calibrationSample(10)).toEqual([]);
	expect((await service.audit()).ok).toBe(true);
	expect(() => service.status()).not.toThrow();
});

test("a stage that fails to start leaves a failed run, not a running one", async () => {
	const t = setup();
	const service = createDistill(t.deps);
	service.registerHandlers();
	// canonical refuses to start before the thresholds are calibrated
	await expect(
		service.startStage("canonical", { dryRun: false }),
	).rejects.toMatchObject({ code: "distill_calibration_missing" });
	const runs = t.deps.store.read((db) => listRuns(db));
	expect(runs.map((r) => [r.stage, r.state])).toEqual([
		["canonical", "failed"],
	]);
	expect(t.deps.store.read((db) => findRunningRun(db, "canonical"))).toBeNull();
});

test("a bad limit or an unknown stage is invalid_distill_request", async () => {
	const t = setup();
	const service = createDistill(t.deps);
	for (const limit of [0, -1, 1.5])
		await expect(
			service.startStage("assess", { dryRun: true, limit }),
		).rejects.toMatchObject({ code: "invalid_distill_request" });
	await expect(
		service.startStage("nope" as never, { dryRun: true }),
	).rejects.toBeInstanceOf(DistillError);
	expect(t.deps.store.read((db) => listRuns(db))).toEqual([]);
});

test("a running stage cannot be started twice", async () => {
	const t = setup();
	const service = createDistill(t.deps);
	await t.deps.store.write((db) =>
		db
			.query(
				"INSERT INTO distill_runs (id, stage, params_json, state, started_at) VALUES ('r0', 'assess', '{}', 'running', 't')",
			)
			.run(),
	);
	await expect(
		service.startStage("assess", { dryRun: false }),
	).rejects.toMatchObject({ code: "distill_stage_running" });
	// another stage is not blocked by it
	await expect(
		service.startStage("canonical", { dryRun: false }),
	).rejects.toMatchObject({ code: "distill_calibration_missing" });
});

test("dry runs and stages with nothing to enqueue complete the run at once; others stay running", async () => {
	const t = setup();
	const seen: string[] = [];
	const module: StageModule = {
		registerHandlers() {
			seen.push("registered");
		},
		start: async (stage, runId, opts) => {
			seen.push(`${stage}:${runId.startsWith("run_")}:${opts.dryRun}`);
			return opts.dryRun ? 3 : stage === "cluster" ? 0 : 2;
		},
	};
	const service = createDistill(t.deps, {
		assess: module,
		cluster: module as never,
		canonical: module,
		conflict: module as never,
		theme: module,
		examples: module,
	});
	const dry = await service.startStage("assess", { dryRun: true, limit: 5 });
	expect(dry.enqueued).toBe(3);
	const empty = await service.startStage("cluster", { dryRun: false });
	expect(empty.enqueued).toBe(0);
	const real = await service.startStage("assess", { dryRun: false });
	expect(real.enqueued).toBe(2);
	const runs = t.deps.store.read((db) => listRuns(db));
	const state = (id: string) => runs.find((r) => r.id === id)!.state;
	expect([state(dry.runId), state(empty.runId), state(real.runId)]).toEqual([
		"completed",
		"completed",
		"running",
	]);
	expect(runs.find((r) => r.id === dry.runId)!.params).toEqual({
		dryRun: true,
		limit: 5,
	});
	// a running assess blocks the next one; embed and incremental route to canonical and cluster
	await expect(
		service.startStage("assess", { dryRun: false }),
	).rejects.toMatchObject({ code: "distill_stage_running" });
	await service.startStage("embed", { dryRun: true });
	await service.startStage("incremental", { dryRun: true });
	expect(seen).toContain("embed:true:true");
	expect(seen).toContain("incremental:true:true");
	service.registerHandlers();
	expect(seen.filter((x) => x === "registered").length).toBe(6);
});

test("recoverRuns fails running runs only when no distill job is open", async () => {
	const t = setup();
	const service = createDistill(t.deps);
	service.registerHandlers();
	await t.deps.store.write((db) =>
		db
			.query(
				"INSERT INTO distill_runs (id, stage, params_json, state, started_at) VALUES ('r0', 'assess', '{}', 'running', 't')",
			)
			.run(),
	);
	expect(await service.recoverRuns()).toBe(1);
	expect(t.deps.store.read((db) => findRunningRun(db, "assess"))).toBeNull();
	// a run with an open job is left alone
	await t.deps.store.write((db) =>
		db
			.query(
				"INSERT INTO distill_runs (id, stage, params_json, state, started_at) VALUES ('r1', 'canonical', '{}', 'running', 't')",
			)
			.run(),
	);
	await t.deps.queue.enqueue({
		kind: "distill.embed",
		scope: "distill",
		subjectRef: "embed:r1",
		dedupeKey: "embed:r1",
		payload: { runId: "r1" },
		lane: "background",
		resourceKey: "embedding",
		maxAttempts: 1,
	} as never);
	expect(await service.recoverRuns()).toBe(0);
	expect(
		t.deps.store.read((db) => findRunningRun(db, "canonical")),
	).not.toBeNull();
});
