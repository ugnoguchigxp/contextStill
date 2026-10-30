import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { registerDistill } from "../controller";
import {
	DistillError,
	type DistillErrorCode,
	type DistillService,
	type ReviewDecision,
	type RunRow,
} from "../contracts";
import { insertReview } from "../repository";
import {
	canonical,
	unit,
	world,
	type World,
} from "../service/conflict/support.test";
import { createDistill } from "../service";
import { T0 } from "./fixtures";

const TOKEN = "api-token-0123456789abcdef0123";

/** The application's bearer check for /api/*, as `createApp` does it; the controller sits behind it. */
function appWith(
	service: DistillService,
	getRun?: (id: string) => RunRow | null,
) {
	const app = new Hono();
	app.use("/api/*", async (c, next) => {
		const presented = /^Bearer\s+(\S+)$/i.exec(
			c.req.header("authorization") ?? "",
		)?.[1];
		if (presented !== TOKEN)
			return c.json({ error: "unauthorized" }, 401, {
				"WWW-Authenticate": "Bearer",
			});
		return next();
	});
	registerDistill(app, { service, ...(getRun ? { getRun } : {}) });
	app.onError((_e, c) => c.json({ error: "internal_error" }, 500));
	const call = (
		path: string,
		init: RequestInit = {},
		token: string | null = TOKEN,
	) =>
		app.request(path, {
			...init,
			headers: {
				...(token ? { authorization: `Bearer ${token}` } : {}),
				...(init.body ? { "content-type": "application/json" } : {}),
			},
		});
	return { app, call };
}

interface Recorded {
	calls: [string, ...unknown[]][];
}
function fakeService(
	over: Partial<DistillService> = {},
): DistillService & Recorded {
	const calls: Recorded["calls"] = [];
	const rec =
		<A extends unknown[], R>(name: string, value: (...a: A) => R) =>
		(...a: A): R => {
			calls.push([name, ...a]);
			return value(...a);
		};
	const thresholds = {
		clusterEdge: 0.93,
		clusterMerge: 0.935,
		clusterCap: 12,
		pairCandidate: 0.9,
		calibratedAt: T0,
	};
	return {
		calls,
		registerHandlers: rec("registerHandlers", () => {}),
		startStage: rec("startStage", async () => ({
			runId: "run_1",
			enqueued: 3,
		})),
		status: rec("status", () => ({ marker: "status" }) as never),
		calibrationSample: rec("calibrationSample", async () => []),
		applyCalibration: rec("applyCalibration", async () => thresholds),
		listReviews: rec("listReviews", () => []),
		resolveReview: rec("resolveReview", async () => {}),
		audit: rec(
			"audit",
			async () => ({ ok: true, violations: [], checked: {} }) as never,
		),
		judgePairs: rec("judgePairs", async () => []),
		recoverRuns: rec("recoverRuns", async () => 0),
		...over,
	};
}

const post = (body: unknown) => ({
	method: "POST",
	body: typeof body === "string" ? body : JSON.stringify(body),
});

test("every endpoint needs the API token", async () => {
	const { call } = appWith(fakeService());
	const endpoints: [string, string][] = [
		["POST", "/api/distill/runs"],
		["GET", "/api/distill/runs/run_1"],
		["GET", "/api/distill/status"],
		["GET", "/api/distill/calibration/sample"],
		["PUT", "/api/distill/calibration"],
		["GET", "/api/distill/reviews"],
		["POST", "/api/distill/reviews/r1/resolve"],
		["GET", "/api/distill/audit"],
	];
	for (const [method, path] of endpoints)
		for (const token of [null, "wrong-token"]) {
			const res = await call(path, { method }, token);
			expect(res.status).toBe(401);
			expect(res.headers.get("www-authenticate")).toBe("Bearer");
			expect(await res.json()).toEqual({ error: "unauthorized" });
		}
});

test("POST /runs: 202 with runId and enqueued; the options reach the service", async () => {
	const svc = fakeService();
	const { call } = appWith(svc);
	let res = await call(
		"/api/distill/runs",
		post({ stage: "canonical", limit: 5, dryRun: true, allowUnverified: true }),
	);
	expect(res.status).toBe(202);
	expect(await res.json()).toEqual({ runId: "run_1", enqueued: 3 });
	res = await call("/api/distill/runs", post({ stage: "conflict" }));
	expect(res.status).toBe(202);
	expect(svc.calls).toEqual([
		[
			"startStage",
			"canonical",
			{ dryRun: true, limit: 5, allowUnverified: true },
		],
		["startStage", "conflict", { dryRun: false }],
	]);
});

test("POST /runs: a bad body is 400 invalid_distill_request and reaches nothing", async () => {
	const svc = fakeService();
	const { call } = appWith(svc);
	for (const body of [
		"not json",
		"",
		{},
		{ stage: "nope" },
		{ stage: "assess", limit: 0 },
		{ stage: "assess", limit: 1.5 },
		{ stage: "assess", dryRun: "yes" },
		{ stage: "assess", extra: 1 },
	]) {
		const res = await call("/api/distill/runs", post(body));
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "invalid_distill_request" });
	}
	expect(svc.calls).toEqual([]);
});

test("a DistillError answers with the status of its code", async () => {
	const table: [DistillErrorCode, number][] = [
		["invalid_distill_request", 400],
		["distill_not_found", 404],
		["distill_stage_running", 409],
		["distill_vectors_unverified", 409],
		["distill_calibration_missing", 409],
		["llm_invalid_output", 502],
		["host_rejected", 422],
	];
	for (const [code, status] of table) {
		const { call } = appWith(
			fakeService({
				startStage: async () => {
					throw new DistillError(code);
				},
			}),
		);
		const res = await call("/api/distill/runs", post({ stage: "canonical" }));
		expect(res.status).toBe(status);
		expect(await res.json()).toEqual({ error: code });
	}
	// anything else goes to the application's error handler
	const { call } = appWith(
		fakeService({
			audit: () => {
				throw new Error("boom");
			},
		}),
	);
	expect((await call("/api/distill/audit")).status).toBe(500);
});

test("GET /runs/:id: the run row, 404 for an unknown id, 501 where no reader is given", async () => {
	const run: RunRow = {
		id: "run_1",
		stage: "conflict",
		params: {},
		state: "running",
		counts: { jobs: 2 },
		startedAt: T0,
		finishedAt: null,
	};
	const { call } = appWith(fakeService(), (id) =>
		id === "run_1" ? run : null,
	);
	const ok = await call("/api/distill/runs/run_1");
	expect(ok.status).toBe(200);
	expect(await ok.json()).toEqual(run);
	const missing = await call("/api/distill/runs/run_9");
	expect(missing.status).toBe(404);
	expect(await missing.json()).toEqual({ error: "distill_not_found" });
	const without = await appWith(fakeService()).call("/api/distill/runs/run_1");
	expect(without.status).toBe(501);
});

test("GET /status and /audit return the service's report", async () => {
	const { call } = appWith(fakeService());
	expect(await (await call("/api/distill/status")).json()).toEqual({
		marker: "status",
	});
	expect(await (await call("/api/distill/audit")).json()).toEqual({
		ok: true,
		violations: [],
		checked: {},
	});
});

test("calibration: sample size defaults to 300 and is bounded; labels are validated", async () => {
	const svc = fakeService();
	const { call } = appWith(svc);
	await call("/api/distill/calibration/sample");
	await call("/api/distill/calibration/sample?n=12");
	expect(svc.calls.map((c) => c[1])).toEqual([300, 12]);
	for (const n of ["0", "-1", "abc", "2001", "1.5"]) {
		const res = await call(`/api/distill/calibration/sample?n=${n}`);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "invalid_distill_request" });
	}
	const labels = [{ pairId: "p1", label: "same", labelSource: "owner" }];
	const ok = await call("/api/distill/calibration", {
		method: "PUT",
		body: JSON.stringify({ labels }),
	});
	expect(ok.status).toBe(200);
	expect(await ok.json()).toMatchObject({
		pairCandidate: 0.9,
		calibratedAt: T0,
	});
	expect(svc.calls.at(-1)).toEqual(["applyCalibration", labels]);
	for (const body of [
		{},
		{ labels: [{ pairId: "p1", label: "maybe", labelSource: "owner" }] },
		{ labels: [{ pairId: "p1", label: "same" }] },
		{ labels: [], extra: 1 },
	]) {
		const res = await call("/api/distill/calibration", {
			method: "PUT",
			body: JSON.stringify(body),
		});
		expect(res.status).toBe(400);
	}
});

test("reviews: list by state (open by default) and resolve with 204", async () => {
	const svc = fakeService();
	const { call } = appWith(svc);
	await call("/api/distill/reviews");
	await call("/api/distill/reviews?state=resolved");
	expect((await call("/api/distill/reviews?state=all")).status).toBe(400);
	expect(svc.calls.map((c) => c[1])).toEqual(["open", "resolved"]);

	const decisions: ReviewDecision[] = [
		{ kind: "a_wins" },
		{ kind: "b_wins" },
		{ kind: "split" },
		{ kind: "keep_both" },
		{ kind: "accept" },
		{ kind: "reject" },
		{ kind: "dismiss" },
		{ kind: "set_generality", generality: "repo_specific" },
	];
	for (const d of decisions) {
		const res = await call("/api/distill/reviews/rv%2F1/resolve", post(d));
		expect(res.status).toBe(204);
		expect(await res.text()).toBe("");
	}
	expect(
		svc.calls.filter((c) => c[0] === "resolveReview").map((c) => [c[1], c[2]]),
	).toEqual(decisions.map((d) => ["rv/1", d]));
	for (const body of [
		{},
		{ kind: "nope" },
		{ kind: "set_generality" },
		{ kind: "set_generality", generality: "huge" },
		{ kind: "a_wins", extra: true },
		"[]",
	]) {
		const res = await call("/api/distill/reviews/r1/resolve", post(body));
		expect(res.status).toBe(400);
	}
	const missing = appWith(
		fakeService({
			resolveReview: async () => {
				throw new DistillError("distill_not_found");
			},
		}),
	);
	expect(
		(
			await missing.call(
				"/api/distill/reviews/zz/resolve",
				post({ kind: "dismiss" }),
			)
		).status,
	).toBe(404);
});

const worlds: World[] = [];
afterEach(async () => {
	for (const w of worlds.splice(0)) await w.dispose();
});

test("with the real service: status, reviews, resolve and audit work over HTTP", async () => {
	const w = await world();
	worlds.push(w);
	await canonical(w.deps, { id: "c1", vec: unit(1, 0, 0) });
	await w.deps.store.write((db) =>
		insertReview(db, {
			id: "g1",
			kind: "generality",
			subject: { ownerKind: "knowledge", ownerId: "ghost" },
			at: T0,
		}),
	);
	const { call } = appWith(createDistill(w.deps));
	const status = (await (await call("/api/distill/status")).json()) as {
		reviews: Record<string, number>;
		canonicals: { active: number };
	};
	expect(status.canonicals.active).toBe(1);
	expect(status.reviews.generality).toBe(1);
	const list = (await (await call("/api/distill/reviews")).json()) as {
		id: string;
	}[];
	expect(list.map((r) => r.id)).toEqual(["g1"]);
	const bad = await call(
		"/api/distill/reviews/g1/resolve",
		post({ kind: "a_wins" }),
	);
	expect(bad.status).toBe(400);
	const gone = await call(
		"/api/distill/reviews/g1/resolve",
		post({ kind: "set_generality", generality: "general" }),
	);
	expect(gone.status).toBe(404);
	expect(
		(await call("/api/distill/reviews/g1/resolve", post({ kind: "dismiss" })))
			.status,
	).toBe(204);
	expect(
		(
			(await (
				await call("/api/distill/reviews?state=dismissed")
			).json()) as unknown[]
		).length,
	).toBe(1);
	const audit = (await (await call("/api/distill/audit")).json()) as {
		ok: boolean;
	};
	expect(audit.ok).toBe(true);
	const run = await call(
		"/api/distill/runs",
		post({ stage: "conflict", dryRun: true }),
	);
	expect(run.status).toBe(202);
	expect(await run.json()).toMatchObject({ enqueued: 0 });
});

test("R2-12: limit has an upper bound", async () => {
	const svc = fakeService();
	const { call } = appWith(svc);
	let res = await call(
		"/api/distill/runs",
		post({ stage: "assess", limit: 10_000 }),
	);
	expect(res.status).toBe(202);
	res = await call(
		"/api/distill/runs",
		post({ stage: "assess", limit: 10_001 }),
	);
	expect(res.status).toBe(400);
	expect(await res.json()).toEqual({ error: "invalid_distill_request" });
});

test("R2-4: the request's signal reaches resolveReview", async () => {
	const svc = fakeService();
	const { call } = appWith(svc);
	await call("/api/distill/reviews/r1/resolve", post({ kind: "dismiss" }));
	const seen = svc.calls.find((x) => x[0] === "resolveReview")!;
	expect(seen[3]).toBeInstanceOf(AbortSignal);
});

test("the audit answer may be a promise", async () => {
	const svc = fakeService({
		audit: (async () => ({ ok: true, violations: [], checked: {} })) as never,
	});
	const { call } = appWith(svc);
	const res = await call("/api/distill/audit");
	expect(res.status).toBe(200);
	expect(await res.json()).toMatchObject({ ok: true });
});
