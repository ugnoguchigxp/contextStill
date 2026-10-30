import type { Context } from "hono";
import type { Hono } from "hono";
import { z } from "zod";
import {
	parseJsonBody,
	parseQuery,
	queryInt,
} from "../../../infrastructure/http";
import {
	DISTILL_STAGES,
	DistillError,
	errorStatus,
	type DistillService,
	type RunRow,
} from "../contracts";

export interface DistillControllerDeps {
	service: DistillService;
	/**
	 * Reads a run row (`distill/repository` getRun). The service has no such method; without it
	 * `GET /api/distill/runs/:id` answers 501.
	 */
	getRun?: (id: string) => RunRow | null;
}

const BAD = "invalid_distill_request";
/** The most units a run may be asked for; a larger number is no more than "all". */
export const MAX_LIMIT = 10_000;

const generality = z.enum([
	"general",
	"generalizable",
	"repo_specific",
	"unusable",
]);

export const startBody = z.strictObject({
	stage: z.enum(DISTILL_STAGES as [string, ...string[]]),
	limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
	dryRun: z.boolean().optional(),
	allowUnverified: z.boolean().optional(),
});

export const calibrationBody = z.strictObject({
	labels: z
		.array(
			z.strictObject({
				pairId: z.string().min(1).max(200),
				label: z.enum(["same", "different", "unsure"]),
				labelSource: z.enum(["agent-draft", "owner"]),
			}),
		)
		.max(5000),
});

export const decisionBody = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.enum(["a_wins", "b_wins", "split", "keep_both"]) }),
	z.strictObject({ kind: z.enum(["accept", "reject"]) }),
	z.strictObject({ kind: z.literal("set_generality"), generality }),
	z.strictObject({ kind: z.literal("dismiss") }),
]);

const sampleQuery = z.object({
	n: queryInt.pipe(z.number().min(1).max(2000)).default(300),
});
const reviewsQuery = z.object({
	state: z.enum(["open", "resolved", "dismissed"]).default("open"),
});

/**
 * /api/distill/* (5.8). The routes sit under the API token of the application (`/api/*`).
 * A `DistillError` answers with the status of `errorStatus` and `{ error: code }`; any other
 * error goes to the application's error handler.
 */
export function registerDistill(app: Hono, deps: DistillControllerDeps) {
	const { service } = deps;
	const guard =
		(handler: (c: Context) => Response | Promise<Response>) =>
		async (c: Context): Promise<Response> => {
			try {
				return await handler(c);
			} catch (error) {
				if (error instanceof DistillError)
					return c.json({ error: error.code }, errorStatus[error.code]);
				throw error;
			}
		};

	app.post(
		"/api/distill/runs",
		guard(async (c) => {
			const body = await parseJsonBody(c, startBody, { code: BAD });
			if (!body.ok) return body.response;
			const { stage, limit, dryRun, allowUnverified } = body.data;
			const started = await service.startStage(stage as never, {
				dryRun: dryRun ?? false,
				...(limit !== undefined ? { limit } : {}),
				...(allowUnverified !== undefined ? { allowUnverified } : {}),
			});
			return c.json(started, 202);
		}),
	);

	app.get(
		"/api/distill/runs/:id",
		guard((c) => {
			if (!deps.getRun) return c.json({ error: "not_implemented" }, 501);
			const run = deps.getRun(c.req.param("id") ?? "");
			return run ? c.json(run) : c.json({ error: "distill_not_found" }, 404);
		}),
	);

	app.get(
		"/api/distill/status",
		guard((c) => c.json(service.status())),
	);

	app.get(
		"/api/distill/calibration/sample",
		guard(async (c) => {
			const q = parseQuery(c, sampleQuery, { code: BAD });
			if (!q.ok) return q.response;
			return c.json(await service.calibrationSample(q.data.n));
		}),
	);

	app.put(
		"/api/distill/calibration",
		guard(async (c) => {
			const body = await parseJsonBody(c, calibrationBody, { code: BAD });
			if (!body.ok) return body.response;
			return c.json(await service.applyCalibration(body.data.labels));
		}),
	);

	app.get(
		"/api/distill/reviews",
		guard((c) => {
			const q = parseQuery(c, reviewsQuery, { code: BAD });
			if (!q.ok) return q.response;
			return c.json(service.listReviews(q.data.state));
		}),
	);

	app.post(
		"/api/distill/reviews/:id/resolve",
		guard(async (c) => {
			const body = await parseJsonBody(c, decisionBody, { code: BAD });
			if (!body.ok) return body.response;
			// The request's signal: a client that goes away stops the model call the decision needs.
			await service.resolveReview(
				c.req.param("id") ?? "",
				body.data,
				c.req.raw.signal,
			);
			return c.body(null, 204);
		}),
	);

	app.get(
		"/api/distill/audit",
		guard(async (c) => c.json(await service.audit())),
	);
}
